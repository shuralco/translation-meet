const signalingUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
const ws = new WebSocket(signalingUrl);

const els = {
  room: document.getElementById('room'),
  name: document.getElementById('name'),
  model: document.getElementById('model'),
  join: document.getElementById('join'),
  leave: document.getElementById('leave'),
  mic: document.getElementById('mic'),
  cam: document.getElementById('cam'),
  share: document.getElementById('share'),
  download: document.getElementById('download'),
  invite: document.getElementById('invite'),
  localVideo: document.getElementById('localVideo'),
  localSubs: document.getElementById('localSubs'),
  localLabel: document.getElementById('localLabel'),
  remoteVideos: document.getElementById('remoteVideos'),
  log: document.getElementById('log'),
};

const state = {
  roomId: null,
  clientId: null,
  localStream: null,
  originalVideoTrack: null,
  screenActive: false,
  peers: new Map(),
  transcriptLog: [],
  sttSocket: null,
  sttRecorder: null,
  deepgramModel: 'nova-2',
};

const SUPPORTED_MODELS = ['nova-2'];

const iceServers = [
  { urls: 'stun:stun.l.google.com:19302' },
  // Add TURN credentials for production deployments
];

const searchParams = new URLSearchParams(window.location.search);
const presetRoom = searchParams.get('room');
const presetName = searchParams.get('name');
const presetModel = searchParams.get('dgModel');

if (presetRoom) {
  els.room.value = presetRoom;
}

let storedName = null;
try {
  storedName = localStorage.getItem('displayName');
} catch {
  storedName = null;
}

if (presetName) {
  els.name.value = presetName;
} else if (storedName) {
  els.name.value = storedName;
}

function resolveModel(value) {
  if (!value) return null;
  const normalized = value.toLowerCase();
  return SUPPORTED_MODELS.find((model) => model === normalized) || null;
}

let storedModel = null;
try {
  storedModel = localStorage.getItem('deepgramModel');
} catch {
  storedModel = null;
}

const initialModel = resolveModel(presetModel) || resolveModel(storedModel) || state.deepgramModel;
state.deepgramModel = initialModel;
if (els.model) {
  els.model.value = initialModel;
}

function updateInviteButtonState() {
  const hasRoom = Boolean((state.roomId || els.room.value || '').trim());
  els.invite.disabled = !hasRoom;
  if (!hasRoom) {
    els.invite.textContent = '🔗 Поділитися кімнатою';
  }
}

updateInviteButtonState();

if (els.model) {
  els.model.addEventListener('change', () => {
    const selected = resolveModel(els.model.value);
    if (!selected) {
      els.model.value = state.deepgramModel;
      return;
    }
    if (selected === state.deepgramModel) return;
    state.deepgramModel = selected;
    storeModelPreference(selected);
    updateHistory();
    if (state.roomId && state.localStream) {
      startTranscriptionStream();
    }
  });
}

ws.addEventListener('open', () => {
  console.log('Signaling socket ready');
});

ws.addEventListener('close', () => {
  console.log('Signaling socket closed');
});

ws.addEventListener('message', async (event) => {
  const msg = JSON.parse(event.data);
  switch (msg.type) {
    case 'joined':
      state.clientId = msg.id;
      state.roomId = msg.roomId;
      updateHistory();
      updateInviteButtonState();
      els.localLabel.textContent = (els.name.value || 'Ви').trim() || 'Ви';
      storeDisplayName();
      await startCall(msg.peers || []);
      break;
    case 'room-full':
      alert(`Кімната вже зайнята максимумом учасників (${msg.max || 4}).`);
      resetJoinButtons();
      break;
    case 'peer-joined':
      onPeerJoined(msg);
      break;
    case 'signal':
      await handleSignal(msg);
      break;
    case 'peer-left':
      removePeer(msg.id);
      break;
    case 'transcript':
      handleTranscript(msg);
      break;
    default:
      break;
  }
});

function sendSignalingMessage(payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function storeDisplayName() {
  try {
    localStorage.setItem('displayName', els.name.value.trim());
  } catch {}
}

function storeModelPreference(model) {
  try {
    localStorage.setItem('deepgramModel', model);
  } catch {}
}

function buildInviteLink() {
  const roomId = (state.roomId || els.room.value || '').trim();
  if (!roomId) return null;
  const url = new URL(window.location.href);
  url.searchParams.set('room', roomId);
  const displayName = (els.name.value || '').trim();
  if (displayName) {
    url.searchParams.set('name', displayName);
  } else {
    url.searchParams.delete('name');
  }
  if (state.deepgramModel) {
    url.searchParams.set('dgModel', state.deepgramModel);
  }
  return url.toString();
}

function updateHistory() {
  const link = buildInviteLink();
  if (!link) return;
  const url = new URL(link);
  history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

async function copyInviteLink() {
  const link = buildInviteLink();
  if (!link) {
    alert('Спочатку вкажіть ID кімнати.');
    return;
  }
  try {
    await navigator.clipboard.writeText(link);
    els.invite.textContent = '✅ Посилання скопійовано';
    setTimeout(() => {
      els.invite.textContent = '🔗 Поділитися кімнатою';
    }, 1800);
  } catch (err) {
    console.warn('Clipboard API недоступний', err);
    prompt('Скопіюйте посилання вручну:', link);
  }
}

async function startCall(existingPeers) {
  toggleControls(true);
  if (!state.localStream) {
    state.localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
      },
      video: { width: 1280, height: 720 },
    });
    els.localVideo.srcObject = state.localStream;
    state.originalVideoTrack = state.localStream.getVideoTracks()[0] || null;
    startTranscriptionStream();
  }

  for (const peerInfo of existingPeers) {
    createPeerConnection(peerInfo.id, peerInfo.name, { initiator: true });
  }
}

function toggleControls(inCall) {
  els.join.disabled = inCall;
  els.leave.disabled = !inCall;
  els.mic.disabled = !inCall;
  els.cam.disabled = !inCall;
  els.share.disabled = !inCall;
  els.download.disabled = !inCall;
  if (inCall) {
    els.mic.textContent = '🎤 Мікрофон вкл';
    els.cam.textContent = '📷 Камера вкл';
  }
}

function onPeerJoined({ id, name }) {
  if (!state.localStream) return;
  if (state.peers.has(id)) return;
  createPeerConnection(id, name, { initiator: false });
}

function createPeerConnection(peerId, name, { initiator }) {
  const peer = {
    id: peerId,
    name: name || 'Учасник',
    pc: new RTCPeerConnection({ iceServers }),
    makingOffer: false,
    ignoreOffer: false,
    polite: !initiator,
    videoSender: null,
    audioSender: null,
    subsTimeout: null,
    elements: createRemoteElements(peerId, name),
  };

  state.peers.set(peerId, peer);

  for (const track of state.localStream.getTracks()) {
    const sender = peer.pc.addTrack(track, state.localStream);
    if (track.kind === 'video') peer.videoSender = sender;
    if (track.kind === 'audio') peer.audioSender = sender;
  }

  peer.pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendSignalingMessage({ type: 'signal', target: peerId, payload: { candidate: event.candidate } });
    }
  };

  peer.pc.ontrack = (event) => {
    const [stream] = event.streams;
    if (stream) {
      peer.elements.video.srcObject = stream;
    }
  };

  peer.pc.onconnectionstatechange = () => {
    if (peer.pc.connectionState === 'failed' || peer.pc.connectionState === 'closed') {
      removePeer(peerId);
    }
  };

  peer.pc.onnegotiationneeded = async () => {
    try {
      peer.makingOffer = true;
      await peer.pc.setLocalDescription(await peer.pc.createOffer());
      sendSignalingMessage({ type: 'signal', target: peerId, payload: { description: peer.pc.localDescription } });
    } catch (err) {
      console.error('Negotiation error', err);
    } finally {
      peer.makingOffer = false;
    }
  };

  // Kick off negotiation for initiators once tracks are added.
  if (initiator) {
    peer.pc.onnegotiationneeded();
  }
}

async function handleSignal({ from, payload }) {
  const peer = state.peers.get(from);
  if (!peer) return;
  const { description, candidate } = payload || {};
  try {
    if (description) {
      const offerCollision = description.type === 'offer' && (peer.makingOffer || peer.pc.signalingState !== 'stable');
      peer.ignoreOffer = !peer.polite && offerCollision;
      if (peer.ignoreOffer) return;

      await peer.pc.setRemoteDescription(description);
      if (description.type === 'offer') {
        await peer.pc.setLocalDescription(await peer.pc.createAnswer());
        sendSignalingMessage({ type: 'signal', target: from, payload: { description: peer.pc.localDescription } });
      }
    } else if (candidate) {
      try {
        await peer.pc.addIceCandidate(candidate);
      } catch (err) {
        if (!peer.ignoreOffer) {
          throw err;
        }
      }
    }
  } catch (err) {
    console.error('Signal handling error', err);
  }
}

function removePeer(peerId) {
  const peer = state.peers.get(peerId);
  if (!peer) return;
  peer.pc.close();
  if (peer.elements.wrapper.parentElement) {
    peer.elements.wrapper.parentElement.removeChild(peer.elements.wrapper);
  }
  if (peer.subsTimeout) {
    clearTimeout(peer.subsTimeout);
  }
  state.peers.delete(peerId);
}

function createRemoteElements(peerId, name) {
  const wrapper = document.createElement('div');
  wrapper.className = 'video-wrapper';
  wrapper.dataset.peerId = peerId;

  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;

  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = name || 'Учасник';

  const subs = document.createElement('div');
  subs.className = 'subs';

  wrapper.appendChild(video);
  wrapper.appendChild(label);
  wrapper.appendChild(subs);
  els.remoteVideos.appendChild(wrapper);

  return { wrapper, video, label, subs };
}

function handleTranscript({ participantId, name, text, final, ts }) {
  if (!text) return;
  const entry = {
    speakerId: participantId,
    speaker: name || 'Учасник',
    text,
    final: Boolean(final),
    ts: ts || Date.now(),
  };
  pushTranscript(entry);
  updateSubtitle(entry);
}

function pushTranscript(entry) {
  state.transcriptLog.push(entry);
  const div = document.createElement('div');
  const isSelf = entry.speakerId === state.clientId;
  div.className = `msg ${isSelf ? 'me' : 'peer'}`;
  div.textContent = `[${new Date(entry.ts).toLocaleTimeString()}] ${entry.speaker}: ${entry.text}`;
  els.log.appendChild(div);
  els.log.scrollTop = els.log.scrollHeight;
}

function updateSubtitle(entry) {
  if (entry.speakerId === state.clientId) {
    els.localSubs.textContent = entry.text;
    if (entry.final) {
      const textSnapshot = entry.text;
      setTimeout(() => {
        if (els.localSubs.textContent === textSnapshot) {
          els.localSubs.textContent = '';
        }
      }, 2000);
    }
    return;
  }

  const peer = state.peers.get(entry.speakerId);
  if (!peer) return;
  peer.elements.label.textContent = entry.speaker || peer.elements.label.textContent;
  peer.elements.subs.textContent = entry.text;
  if (peer.subsTimeout) {
    clearTimeout(peer.subsTimeout);
  }
  if (entry.final) {
    const textSnapshot = entry.text;
    peer.subsTimeout = setTimeout(() => {
      if (peer.elements.subs.textContent === textSnapshot) {
        peer.elements.subs.textContent = '';
      }
    }, 2000);
  }
}

function startTranscriptionStream() {
  if (!state.roomId || !state.clientId || !state.localStream) return;
  if (typeof MediaRecorder === 'undefined') {
    console.warn('MediaRecorder не підтримується цим браузером.');
    return;
  }
  if (state.sttSocket) {
    state.sttSocket.close();
  }
  const name = encodeURIComponent(els.name.value || 'Учасник');
  const model = encodeURIComponent(state.deepgramModel || SUPPORTED_MODELS[0]);
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/stt?roomId=${encodeURIComponent(state.roomId)}&participantId=${encodeURIComponent(state.clientId)}&name=${name}&model=${model}`;
  const sttSocket = new WebSocket(url);
  sttSocket.binaryType = 'arraybuffer';
  state.sttSocket = sttSocket;

  sttSocket.addEventListener('open', () => {
    if (state.sttRecorder && state.sttRecorder.state !== 'inactive') {
      state.sttRecorder.stop();
    }
    const recorder = new MediaRecorder(state.localStream, {
      mimeType: 'audio/webm;codecs=opus',
      audioBitsPerSecond: 128000,
    });
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data && event.data.size > 0 && sttSocket.readyState === WebSocket.OPEN) {
        sttSocket.send(event.data);
      }
    });
    recorder.start(250);
    state.sttRecorder = recorder;
  });

  const closeRecorder = () => {
    if (state.sttRecorder && state.sttRecorder.state !== 'inactive') {
      state.sttRecorder.stop();
    }
    state.sttRecorder = null;
  };

  sttSocket.addEventListener('close', closeRecorder);
  sttSocket.addEventListener('error', closeRecorder);
}

function stopTranscriptionStream() {
  if (state.sttRecorder && state.sttRecorder.state !== 'inactive') {
    state.sttRecorder.stop();
  }
  state.sttRecorder = null;
  if (state.sttSocket && state.sttSocket.readyState === WebSocket.OPEN) {
    state.sttSocket.close();
  }
  state.sttSocket = null;
}

function leaveCall() {
  stopTranscriptionStream();
  toggleControls(false);

  for (const peerId of state.peers.keys()) {
    removePeer(peerId);
  }

  if (state.localStream) {
    state.localStream.getTracks().forEach((track) => track.stop());
    state.localStream = null;
  }
  els.localVideo.srcObject = null;
  els.localSubs.textContent = '';
  els.log.textContent = '';
  state.transcriptLog = [];

  if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
    ws.close();
  }
  location.reload();
}

function replaceVideoTrack(track) {
  for (const peer of state.peers.values()) {
    if (peer.videoSender) {
      peer.videoSender.replaceTrack(track);
    }
  }
}

function downloadTranscript() {
  if (!state.transcriptLog.length) return;
  const lines = state.transcriptLog
    .map((entry) => `[${new Date(entry.ts).toISOString()}] ${entry.speaker}: ${entry.text}`)
    .join('\n');
  const blob = new Blob([lines], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `transcript_${state.roomId || 'call'}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

function resetJoinButtons() {
  els.join.disabled = false;
  els.leave.disabled = true;
}

// UI events
els.invite.addEventListener('click', copyInviteLink);
els.room.addEventListener('input', updateInviteButtonState);
els.name.addEventListener('change', () => {
  storeDisplayName();
  if (state.roomId) updateHistory();
  els.localLabel.textContent = (els.name.value || 'Ви').trim() || 'Ви';
});
els.join.addEventListener('click', () => {
  const roomId = els.room.value.trim();
  if (!roomId) {
    alert('Вкажіть ID кімнати');
    return;
  }
  const displayName = (els.name.value || '').trim() || 'Учасник';
  const sendJoin = () => sendSignalingMessage({ type: 'join', roomId, displayName });
  if (ws.readyState === WebSocket.OPEN) {
    sendJoin();
  } else if (ws.readyState === WebSocket.CONNECTING) {
    ws.addEventListener('open', sendJoin, { once: true });
  } else {
    alert('Помилка підключення до сигналінгу. Перезавантажте сторінку.');
    return;
  }
  els.join.disabled = true;
});
els.leave.addEventListener('click', leaveCall);
els.mic.addEventListener('click', () => {
  if (!state.localStream) return;
  const track = state.localStream.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  els.mic.textContent = track.enabled ? '🎤 Мікрофон вкл' : '🔇 Мікрофон викл';
});
els.cam.addEventListener('click', () => {
  if (!state.localStream) return;
  const track = state.localStream.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  els.cam.textContent = track.enabled ? '📷 Камера вкл' : '🚫 Камера викл';
});
els.share.addEventListener('click', async () => {
  if (state.screenActive) return;
  try {
    const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const screenTrack = displayStream.getVideoTracks()[0];
    if (!screenTrack) return;
    replaceVideoTrack(screenTrack);
    els.localVideo.srcObject = displayStream;
    state.screenActive = true;
    screenTrack.onended = () => {
      if (state.originalVideoTrack) {
        replaceVideoTrack(state.originalVideoTrack);
      }
      if (state.localStream) {
        els.localVideo.srcObject = state.localStream;
      }
      state.screenActive = false;
    };
  } catch (err) {
    console.warn('Screen share cancelled', err);
  }
});
els.download.addEventListener('click', downloadTranscript);

window.addEventListener('beforeunload', () => {
  stopTranscriptionStream();
  if (ws.readyState === WebSocket.OPEN) {
    ws.close();
  }
});
