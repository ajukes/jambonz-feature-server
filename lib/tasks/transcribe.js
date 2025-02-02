const Task = require('./task');
const {
  TaskName,
  TaskPreconditions,
  GoogleTranscriptionEvents,
  NuanceTranscriptionEvents,
  AwsTranscriptionEvents,
  AzureTranscriptionEvents,
  DeepgramTranscriptionEvents,
  SonioxTranscriptionEvents,
  IbmTranscriptionEvents,
  NvidiaTranscriptionEvents,
  JambonzTranscriptionEvents
} = require('../utils/constants');
const { normalizeJambones } = require('@jambonz/verb-specifications');

const STT_LISTEN_SPAN_NAME = 'stt-listen';

class TaskTranscribe extends Task {
  constructor(logger, opts, parentTask) {
    super(logger, opts);
    this.preconditions = TaskPreconditions.Endpoint;
    this.parentTask = parentTask;

    const {
      setChannelVarsForStt,
      normalizeTranscription,
      removeSpeechListeners,
      setSpeechCredentialsAtRuntime,
      compileSonioxTranscripts
    } = require('../utils/transcription-utils')(logger);
    this.setChannelVarsForStt = setChannelVarsForStt;
    this.normalizeTranscription = normalizeTranscription;
    this.removeSpeechListeners = removeSpeechListeners;
    this.compileSonioxTranscripts = compileSonioxTranscripts;

    this.transcriptionHook = this.data.transcriptionHook;
    this.earlyMedia = this.data.earlyMedia === true || (parentTask && parentTask.earlyMedia);

    if (this.data.recognizer) {
      const recognizer = this.data.recognizer;
      this.vendor = recognizer.vendor;
      this.language = recognizer.language;
      /* let credentials be supplied in the recognizer object at runtime */
      this.sttCredentials = setSpeechCredentialsAtRuntime(recognizer);

      this.interim = !!recognizer.interim;
      this.separateRecognitionPerChannel = recognizer.separateRecognitionPerChannel;

      this.data.recognizer.hints = this.data.recognizer.hints || [];
      this.data.recognizer.altLanguages = this.data.recognizer.altLanguages || [];
    }
    else this.data.recognizer = {hints: [], altLanguages: []};

    /* buffer for soniox transcripts */
    this._sonioxTranscripts = [];

    this.childSpan = [null, null];
  }

  get name() { return TaskName.Transcribe; }

  async exec(cs, {ep, ep2}) {
    super.exec(cs);
    const {updateSpeechCredentialLastUsed} = require('../utils/db-utils')(this.logger, cs.srf);
    const {getNuanceAccessToken, getIbmAccessToken} = cs.srf.locals.dbHelpers;

    if (cs.hasGlobalSttHints) {
      const {hints, hintsBoost} = cs.globalSttHints;
      this.data.recognizer.hints = this.data.recognizer.hints.concat(hints);
      if (!this.data.recognizer.hintsBoost && hintsBoost) this.data.recognizer.hintsBoost = hintsBoost;
      this.logger.debug({hints: this.data.recognizer.hints, hintsBoost: this.data.recognizer.hintsBoost},
        'Transcribe:exec - applying global sttHints');
    }
    if (cs.hasAltLanguages) {
      this.data.recognizer.altLanguages = this.data.recognizer.altLanguages.concat(cs.altLanguages);
      this.logger.debug({altLanguages: this.altLanguages},
        'Transcribe:exec - applying altLanguages');
    }
    if (cs.hasGlobalSttPunctuation && !this.data.recognizer.punctuation) {
      this.data.recognizer.punctuation = cs.globalSttPunctuation;
    }

    this.ep = ep;
    this.ep2 = ep2;
    if ('default' === this.vendor || !this.vendor) {
      this.vendor = cs.speechRecognizerVendor;
      if (this.data.recognizer) this.data.recognizer.vendor = this.vendor;
    }
    if ('default' === this.language || !this.language) {
      this.language = cs.speechRecognizerLanguage;
      if (this.data.recognizer) this.data.recognizer.language = this.language;
    }
    if (!this.data.recognizer.vendor) {
      this.data.recognizer.vendor = this.vendor;
    }
    if (!this.sttCredentials) this.sttCredentials = cs.getSpeechCredentials(this.vendor, 'stt');

    try {
      if (!this.sttCredentials) {
        const {writeAlerts, AlertType} = cs.srf.locals;
        this.logger.info(`TaskTranscribe:exec - ERROR stt using ${this.vendor} requested but creds not supplied`);
        writeAlerts({
          account_sid: cs.accountSid,
          alert_type: AlertType.STT_NOT_PROVISIONED,
          vendor: this.vendor
        }).catch((err) => this.logger.info({err}, 'Error generating alert for no stt'));
        throw new Error('no provisioned speech credentials for TTS');
      }

      if (this.vendor === 'nuance' && this.sttCredentials.client_id) {
        /* get nuance access token */
        const {client_id, secret} = this.sttCredentials;
        const {access_token, servedFromCache} = await getNuanceAccessToken(client_id, secret, 'asr tts');
        this.logger.debug({client_id},
          `Transcribe:exec - got nuance access token ${servedFromCache ? 'from cache' : ''}`);
        this.sttCredentials = {...this.sttCredentials, access_token};
      }
      else if (this.vendor == 'ibm' && this.sttCredentials.stt_api_key) {
        /* get ibm access token */
        const {stt_api_key, stt_region} = this.sttCredentials;
        const {access_token, servedFromCache} = await getIbmAccessToken(stt_api_key);
        this.logger.debug({stt_api_key}, `Gather:exec - got ibm access token ${servedFromCache ? 'from cache' : ''}`);
        this.sttCredentials = {...this.sttCredentials, access_token, stt_region};
      }
      await this._startTranscribing(cs, ep, 1);
      if (this.separateRecognitionPerChannel && ep2) {
        await this._startTranscribing(cs, ep2, 2);
      }

      updateSpeechCredentialLastUsed(this.sttCredentials.speech_credential_sid)
        .catch(() => {/*already logged error */});

      await this.awaitTaskDone();
    } catch (err) {
      this.logger.info(err, 'TaskTranscribe:exec - error');
      this.parentTask && this.parentTask.emit('error', err);
    }
    this.removeSpeechListeners(ep);
  }

  async kill(cs) {
    super.kill(cs);
    let stopTranscription = false;
    if (this.ep?.connected) {
      stopTranscription = true;
      this.ep.stopTranscription({vendor: this.vendor})
        .catch((err) => this.logger.info(err, 'Error TaskTranscribe:kill'));
    }
    if (this.separateRecognitionPerChannel && this.ep2 && this.ep2.connected) {
      stopTranscription = true;
      this.ep2.stopTranscription({vendor: this.vendor})
        .catch((err) => this.logger.info(err, 'Error TaskTranscribe:kill'));
    }
    // hangup after 1 sec if we don't get a final transcription
    if (stopTranscription) this._timer = setTimeout(() => this.notifyTaskDone(), 1500);
    else this.notifyTaskDone();

    await this.awaitTaskDone();
  }

  async _startTranscribing(cs, ep, channel) {
    const opts = this.setChannelVarsForStt(this, this.sttCredentials, this.data.recognizer);
    switch (this.vendor) {
      case 'google':
        this.bugname = 'google_transcribe';
        ep.addCustomEventListener(GoogleTranscriptionEvents.Transcription,
          this._onTranscription.bind(this, cs, ep, channel));
        ep.addCustomEventListener(GoogleTranscriptionEvents.NoAudioDetected,
          this._onNoAudio.bind(this, cs, ep, channel));
        ep.addCustomEventListener(GoogleTranscriptionEvents.MaxDurationExceeded,
          this._onMaxDurationExceeded.bind(this, cs, ep, channel));
        break;

      case 'aws':
      case 'polly':
        this.bugname = 'aws_transcribe';
        ep.addCustomEventListener(AwsTranscriptionEvents.Transcription,
          this._onTranscription.bind(this, cs, ep, channel));
        ep.addCustomEventListener(AwsTranscriptionEvents.NoAudioDetected,
          this._onNoAudio.bind(this, cs, ep, channel));
        ep.addCustomEventListener(AwsTranscriptionEvents.MaxDurationExceeded,
          this._onMaxDurationExceeded.bind(this, cs, ep, channel));
        break;
      case 'microsoft':
        this.bugname = 'azure_transcribe';
        ep.addCustomEventListener(AzureTranscriptionEvents.Transcription,
          this._onTranscription.bind(this, cs, ep, channel));
        ep.addCustomEventListener(AzureTranscriptionEvents.NoSpeechDetected,
          this._onNoAudio.bind(this, cs, ep, channel));
        break;
      case 'nuance':
        this.bugname = 'nuance_transcribe';
        ep.addCustomEventListener(NuanceTranscriptionEvents.Transcription,
          this._onTranscription.bind(this, cs, ep, channel));
        ep.addCustomEventListener(NuanceTranscriptionEvents.StartOfSpeech,
          this._onStartOfSpeech.bind(this, cs, ep, channel));
        ep.addCustomEventListener(NuanceTranscriptionEvents.TranscriptionComplete,
          this._onTranscriptionComplete.bind(this, cs, ep, channel));
        break;
      case 'deepgram':
        this.bugname = 'deepgram_transcribe';
        ep.addCustomEventListener(DeepgramTranscriptionEvents.Transcription,
          this._onTranscription.bind(this, cs, ep, channel));
        ep.addCustomEventListener(DeepgramTranscriptionEvents.Connect,
          this._onDeepgramConnect.bind(this, cs, ep, channel));
        ep.addCustomEventListener(DeepgramTranscriptionEvents.ConnectFailure,
          this._onDeepGramConnectFailure.bind(this, cs, ep, channel));
        break;
      case 'soniox':
        this.bugname = 'soniox_transcribe';
        ep.addCustomEventListener(SonioxTranscriptionEvents.Transcription,
          this._onTranscription.bind(this, cs, ep, channel));
        break;
      case 'ibm':
        this.bugname = 'ibm_transcribe';
        ep.addCustomEventListener(IbmTranscriptionEvents.Transcription,
          this._onTranscription.bind(this, cs, ep, channel));
        ep.addCustomEventListener(IbmTranscriptionEvents.Connect,
          this._onIbmConnect.bind(this, cs, ep, channel));
        ep.addCustomEventListener(IbmTranscriptionEvents.ConnectFailure,
          this._onIbmConnectFailure.bind(this, cs, ep, channel));
        break;

      case 'nvidia':
        this.bugname = 'nvidia_transcribe';
        ep.addCustomEventListener(NvidiaTranscriptionEvents.Transcription,
          this._onTranscription.bind(this, cs, ep));
        ep.addCustomEventListener(NvidiaTranscriptionEvents.StartOfSpeech,
          this._onStartOfSpeech.bind(this, cs, ep));
        ep.addCustomEventListener(NvidiaTranscriptionEvents.TranscriptionComplete,
          this._onTranscriptionComplete.bind(this, cs, ep));
        ep.addCustomEventListener(NvidiaTranscriptionEvents.VadDetected,
          this._onVadDetected.bind(this, cs, ep));
        break;
      default:
        throw new Error(`Invalid vendor ${this.vendor}`);
    }

    /* common handler for all stt engine errors */
    ep.addCustomEventListener(JambonzTranscriptionEvents.Error, this._onJambonzError.bind(this, cs, ep));
    await ep.set(opts)
      .catch((err) => this.logger.info(err, 'Error setting channel variables'));

    await this._transcribe(ep);

    /* start child span for this channel */
    const {span, ctx} = this.startChildSpan(`${STT_LISTEN_SPAN_NAME}:${channel}`);
    this.childSpan[channel - 1] = {span, ctx};
  }

  async _transcribe(ep) {
    await ep.startTranscription({
      vendor: this.vendor,
      interim: this.interim ? true : false,
      locale: this.language,
      channels: /*this.separateRecognitionPerChannel ? 2 : */ 1,
      bugname: this.bugname
    });
  }

  async _onTranscription(cs, ep, channel, evt, fsEvent) {
    // make sure this is not a transcript from answering machine detection
    const bugname = fsEvent.getHeader('media-bugname');
    if (bugname && this.bugname !== bugname) return;

    if (this.vendor === 'ibm') {
      if (evt?.state === 'listening') return;
    }
    this.logger.debug({evt}, 'TaskTranscribe:_onTranscription - before normalization');

    evt = this.normalizeTranscription(evt, this.vendor, channel, this.language);
    this.logger.debug({evt}, 'TaskTranscribe:_onTranscription');
    if (evt.alternatives.length === 0) {
      this.logger.info({evt}, 'TaskTranscribe:_onTranscription - got empty transcript, continue listening');
      return;
    }

    if (evt.alternatives[0]?.transcript === '' && !cs.callGone && !this.killed) {
      if (['microsoft', 'deepgram'].includes(this.vendor)) {
        this.logger.info({evt}, 'TaskTranscribe:_onTranscription - got empty transcript, continue listening');
      }
      else {
        this.logger.info({evt}, 'TaskTranscribe:_onTranscription - got empty transcript, listen again');
        this._transcribe(ep);
      }
      return;
    }

    if (this.vendor === 'soniox') {
      /* compile transcripts into one */
      this._sonioxTranscripts.push(evt.vendor.finalWords);
      if (evt.is_final) {
        evt = this.compileSonioxTranscripts(this._sonioxTranscripts, 1, this.language);
        this._sonioxTranscripts = [];
      }
    }

    /* we've got a transcript, so end the otel child span for this channel */
    if (this.childSpan[channel - 1] && this.childSpan[channel - 1].span) {
      this.childSpan[channel - 1].span.setAttributes({
        channel,
        'stt.resolve': 'transcript',
        'stt.result': JSON.stringify(evt)
      });
      this.childSpan[channel - 1].span.end();
    }

    if (this.transcriptionHook) {
      const b3 = this.getTracingPropagation();
      const httpHeaders = b3 && {b3};
      try {
        const json = await this.cs.requestor.request('verb:hook', this.transcriptionHook, {
          ...this.cs.callInfo,
          ...httpHeaders,
          speech: evt
        });
        this.logger.info({json}, 'sent transcriptionHook');
        if (json && Array.isArray(json) && !this.parentTask) {
          const makeTask = require('./make_task');
          const tasks = normalizeJambones(this.logger, json).map((tdata) => makeTask(this.logger, tdata));
          if (tasks && tasks.length > 0) {
            this.logger.info({tasks: tasks}, `${this.name} replacing application with ${tasks.length} tasks`);
            this.cs.replaceApplication(tasks);
          }
        }
      } catch (err) {
        this.logger.info(err, 'TranscribeTask:_onTranscription error');
      }
    }
    if (this.parentTask) {
      this.parentTask.emit('transcription', evt);
    }
    if (this.killed) {
      this.logger.debug('TaskTranscribe:_onTranscription exiting after receiving final transcription');
      this._clearTimer();
      this.notifyTaskDone();
    }
    else {
      /* start another child span for this channel */
      const {span, ctx} = this.startChildSpan(`${STT_LISTEN_SPAN_NAME}:${channel}`);
      this.childSpan[channel - 1] = {span, ctx};
    }
  }

  _onNoAudio(cs, ep, channel) {
    this.logger.debug(`TaskTranscribe:_onNoAudio restarting transcription on channel ${channel}`);
    if (this.childSpan[channel - 1] && this.childSpan[channel - 1].span) {
      this.childSpan[channel - 1].span.setAttributes({
        channel,
        'stt.resolve': 'timeout'
      });
      this.childSpan[channel - 1].span.end();
    }
    this._transcribe(ep);

    /* start new child span for this channel */
    const {span, ctx} = this.startChildSpan(`${STT_LISTEN_SPAN_NAME}:${channel}`);
    this.childSpan[channel - 1] = {span, ctx};
  }

  _onMaxDurationExceeded(cs, ep, channel) {
    this.logger.debug(`TaskTranscribe:_onMaxDurationExceeded restarting transcription on channel ${channel}`);
    if (this.childSpan[channel - 1] && this.childSpan[channel - 1].span) {
      this.childSpan[channel - 1].span.setAttributes({
        channel,
        'stt.resolve': 'max duration exceeded'
      });
      this.childSpan[channel - 1].span.end();
    }

    this._transcribe(ep);

    /* start new child span for this channel */
    const {span, ctx} = this.startChildSpan(`${STT_LISTEN_SPAN_NAME}:${channel}`);
    this.childSpan[channel - 1] = {span, ctx};
  }

  _clearTimer() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }
  _onDeepgramConnect(_cs, _ep) {
    this.logger.debug('TaskTranscribe:_onDeepgramConnect');
  }

  _onDeepGramConnectFailure(cs, _ep, channel, evt) {
    const {reason} = evt;
    const {writeAlerts, AlertType} = cs.srf.locals;
    this.logger.info({evt}, 'TaskTranscribe:_onDeepgramConnectFailure');
    writeAlerts({
      account_sid: cs.accountSid,
      alert_type: AlertType.STT_FAILURE,
      message: `Failed connecting to Deepgram speech recognizer: ${reason}`,
      vendor: 'deepgram',
    }).catch((err) => this.logger.info({err}, 'Error generating alert for deepgram connection failure'));
    this.notifyError(`Failed connecting to speech vendor deepgram: ${reason}`);

    if (this.childSpan[channel - 1] && this.childSpan[channel - 1].span) {
      this.childSpan[channel - 1].span.setAttributes({
        channel,
        'stt.resolve': 'connection failure'
      });
      this.childSpan[channel - 1].span.end();
    }
    this.notifyTaskDone();
  }

  _onIbmConnect(_cs, _ep) {
    this.logger.debug('TaskTranscribe:_onIbmConnect');
  }

  _onIbmConnectFailure(cs, _ep, channel, evt) {
    const {reason} = evt;
    const {writeAlerts, AlertType} = cs.srf.locals;
    this.logger.info({evt}, 'TaskTranscribe:_onIbmConnectFailure');
    writeAlerts({
      account_sid: cs.accountSid,
      alert_type: AlertType.STT_FAILURE,
      message: `Failed connecting to IBM watson speech recognizer: ${reason}`,
      vendor: 'ibm',
    }).catch((err) => this.logger.info({err}, 'Error generating alert for IBM connection failure'));
    this.notifyError(`Failed connecting to speech vendor IBM: ${reason}`);

    if (this.childSpan[channel - 1] && this.childSpan[channel - 1].span) {
      this.childSpan[channel - 1].span.setAttributes({
        channel,
        'stt.resolve': 'connection failure'
      });
      this.childSpan[channel - 1].span.end();
    }
    this.notifyTaskDone();
  }
  _onIbmError(cs, _ep, _channel, evt) {
    this.logger.info({evt}, 'TaskTranscribe:_onIbmError');
  }
  _onJambonzError(cs, _ep, evt) {
    this.logger.info({evt}, 'TaskTranscribe:_onJambonzError');
    const {writeAlerts, AlertType} = cs.srf.locals;

    if (this.vendor === 'nuance') {
      const {code, error} = evt;
      if (code === 404 && error === 'No speech') return this._resolve('timeout');
      if (code === 413 && error === 'Too much speech') return this._resolve('timeout');
    }
    this.logger.info({evt}, 'TaskTranscribe:_onJambonzError');
    writeAlerts({
      account_sid: cs.accountSid,
      alert_type: AlertType.STT_FAILURE,
      message: `Custom speech vendor ${this.vendor} error: ${evt.error}`,
      vendor: this.vendor,
    }).catch((err) => this.logger.info({err}, 'Error generating alert for jambonz custom connection failure'));
    this.notifyError({msg: 'ASR error', details:`Custom speech vendor ${this.vendor} error: ${evt.error}`});
  }


}

module.exports = TaskTranscribe;
