const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);

const els = {
  room: document.getElementById('room'),
  name: document.getElementById('name'),
  join: document.getElementById('join'),
  leave: document.getElementById('leave'),
  mic: document.getElementById('mic'),
  cam: document.getElementById('cam'),
  share: document.getElementById('share'),
  download: document.getElementById('download'),
  invite: document.getElementById('invite'),
  lang: document.getElementById('lang'),
  localVideo: document.getElementById('localVideo'),
  remoteVideo: document.getElementById('remoteVideo'),
  localSubs: document.getElementById('localSubs'),
  remoteSubs: document.getElementById('remoteSubs'),
  log: document.getElementById('log'),
};

let pc;
let isPolite = false;
let makingOffer = false;
let ignoreOffer = false;
let localStream;
let screenActive = false;
let dataChannel;
const transcriptLog = [];
let recognition;
let joinedRoomId = null;

const searchParams = new URLSearchParams(window.location.search);
const presetRoom = searchParams.get('room');
const presetName = searchParams.get('name');
const presetLang = searchParams.get('lang');

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

if (presetLang) {
  const hasLang = Array.from(els.lang.options).some((option) => option.value === presetLang);
  if (hasLang) {
    els.lang.value = presetLang;
  }
}

function updateInviteButtonState() {
  const hasRoom = Boolean(els.room.value.trim());
  els.invite.disabled = !hasRoom;
  if (!hasRoom) {
    els.invite.textContent = '🔗 Поділитися кімнатою';
  }
}

updateInviteButtonState();

const iceServers = [
  { urls: 'stun:stun.l.google.com:19302' },
  // Add TURN servers here for production usage
];

ws.addEventListener('open', () => {
  console.log('WebSocket connected');
});

ws.addEventListener('close', () => {
  console.log('WebSocket closed');
});

ws.addEventListener('message', async (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === 'joined') {
    isPolite = Boolean(msg.isPolite);
    joinedRoomId = msg.roomId;
    updateInviteButtonState();
    updateHistory(joinedRoomId);
    await startCall();
    return;
  }
  if (msg.type === 'room-full') {
    alert('Кімната вже зайнята двома учасниками.');
    resetJoinButtons();
    return;
  }
  if (msg.type === 'signal' && pc) {
    const { description, candidate } = msg.payload || {};
    try {
      if (description) {
        const offerCollision = description.type === 'offer' && (makingOffer || pc.signalingState !== 'stable');
        ignoreOffer = !isPolite && offerCollision;
        if (ignoreOffer) return;

        await pc.setRemoteDescription(description);
        if (description.type === 'offer') {
          await pc.setLocalDescription(await pc.createAnswer());
          sendSignal({ description: pc.localDescription });
        }
      } else if (candidate) {
        if (!ignoreOffer) {
          await pc.addIceCandidate(candidate);
        }
      }
    } catch (err) {
      console.error('Error handling signal', err);
    }
    return;
  }
  if (msg.type === 'transcript') {
    const payload = { speaker: msg.from || 'Peer', text: msg.text, final: msg.final, ts: msg.ts };
    pushTranscript(payload);
    showRemoteSubtitle(payload);
  }
});

function sendSignal(payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'signal', payload }));
  }
}

function buildInviteLink(roomIdOverride) {
  const roomId = (roomIdOverride || els.room.value || '').trim();
  if (!roomId) return null;
  const url = new URL(window.location.href);
  url.searchParams.set('room', roomId);
  const displayName = (els.name.value || '').trim();
  if (displayName) {
    url.searchParams.set('name', displayName);
  } else {
    url.searchParams.delete('name');
  }
  if (els.lang.value) {
    url.searchParams.set('lang', els.lang.value);
  }
  return url.toString();
}

function updateHistory(roomIdOverride) {
  const link = buildInviteLink(roomIdOverride);
  if (!link) return;
  const url = new URL(link);
  history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

async function copyInviteLink() {
  const link = buildInviteLink(joinedRoomId);
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

async function startCall() {
  els.leave.disabled = false;
  els.mic.disabled = false;
  els.cam.disabled = false;
  els.share.disabled = false;
  els.download.disabled = false;

  localStream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: { width: 1280, height: 720 },
  });
  els.localVideo.srcObject = localStream;

  pc = new RTCPeerConnection({ iceServers });
  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendSignal({ candidate: event.candidate });
    }
  };

  pc.ontrack = (event) => {
    if (!els.remoteVideo.srcObject) {
      els.remoteVideo.srcObject = event.streams[0];
    }
  };

  if (!isPolite) {
    dataChannel = pc.createDataChannel('captions', { ordered: true });
    wireDataChannel(dataChannel);
  } else {
    pc.ondatachannel = (event) => {
      dataChannel = event.channel;
      wireDataChannel(dataChannel);
    };
  }

  pc.onnegotiationneeded = async () => {
    try {
      makingOffer = true;
      await pc.setLocalDescription(await pc.createOffer());
      sendSignal({ description: pc.localDescription });
    } catch (err) {
      console.error('Negotiation error', err);
    } finally {
      makingOffer = false;
    }
  };

  els.remoteVideo.play().catch(() => {});

  startLocalSTT();
}

function wireDataChannel(channel) {
  channel.onopen = () => console.log('DataChannel open');
  channel.onclose = () => console.log('DataChannel closed');
  channel.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.kind === 'transcript') {
        const payload = { speaker: msg.from || 'Peer', text: msg.text, final: msg.final, ts: msg.ts };
        pushTranscript(payload);
        showRemoteSubtitle(payload);
      }
    } catch (err) {
      console.warn('Invalid datachannel message', err);
    }
  };
}

function pushTranscript({ speaker, text, final = false, ts = Date.now() }) {
  if (!text) return;
  transcriptLog.push({ speaker, text, final, ts });
  const div = document.createElement('div');
  const currentName = (els.name.value || 'Me').trim() || 'Me';
  div.className = `msg ${speaker === currentName ? 'me' : 'peer'}`;
  div.textContent = `[${new Date(ts).toLocaleTimeString()}] ${speaker}: ${text}`;
  els.log.appendChild(div);
  els.log.scrollTop = els.log.scrollHeight;
}

function showRemoteSubtitle({ text, final }) {
  if (!text) return;
  els.remoteSubs.textContent = text;
  if (final) {
    setTimeout(() => {
      els.remoteSubs.textContent = '';
    }, 1800);
  }
}

function showLocalSubtitle(text) {
  els.localSubs.textContent = text;
}

function sendCaption(text, final = false) {
  if (!text) return;
  const payload = {
    kind: 'transcript',
    from: (els.name.value || 'Me').trim() || 'Me',
    text,
    final,
    ts: Date.now(),
  };
  if (dataChannel && dataChannel.readyState === 'open') {
    dataChannel.send(JSON.stringify(payload));
  } else if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'transcript', data: payload }));
  }
}

function startLocalSTT() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    showLocalSubtitle('SpeechRecognition не підтримується в цьому браузері.');
    return;
  }
  recognition = new SpeechRecognition();
  recognition.lang = els.lang.value || 'uk-UA';
  recognition.continuous = true;
  recognition.interimResults = true;

  recognition.onresult = (event) => {
    let interim = '';
    let finalText = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      if (result.isFinal) {
        finalText += `${result[0].transcript.trim()} `;
      } else {
        interim += result[0].transcript;
      }
    }
    if (interim) {
      showLocalSubtitle(interim);
      sendCaption(interim, false);
      pushTranscript({ speaker: (els.name.value || 'Me').trim() || 'Me', text: interim, final: false });
    }
    if (finalText) {
      const text = finalText.trim();
      showLocalSubtitle('');
      sendCaption(text, true);
      pushTranscript({ speaker: (els.name.value || 'Me').trim() || 'Me', text, final: true });
    }
  };

  recognition.onerror = (event) => {
    console.warn('STT error', event.error);
  };

  recognition.onend = () => {
    if (pc && !els.leave.disabled) {
      try {
        recognition.start();
      } catch (err) {
        console.warn('Failed to restart recognition', err);
      }
    }
  };

  try {
    recognition.start();
  } catch (err) {
    console.warn('Failed to start recognition', err);
  }
}

function stopLocalSTT() {
  if (recognition) {
    try {
      recognition.onresult = null;
      recognition.onend = null;
      recognition.stop();
    } catch (err) {
      console.warn('Failed to stop recognition', err);
    }
    recognition = null;
  }
  showLocalSubtitle('');
}

function leaveCall() {
  resetJoinButtons();
  stopLocalSTT();

  if (pc) {
    pc.getSenders().forEach((sender) => {
      if (sender.track) sender.track.stop();
    });
    pc.close();
  }
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
  }
  els.localVideo.srcObject = null;
  els.remoteVideo.srcObject = null;
  pc = null;
  localStream = null;
  screenActive = false;
  dataChannel = null;
  joinedRoomId = null;

  if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
    ws.close();
  }
  setTimeout(() => {
    location.reload();
  }, 0);
}

function resetJoinButtons() {
  els.join.disabled = false;
  els.leave.disabled = true;
  els.mic.disabled = true;
  els.cam.disabled = true;
  els.share.disabled = true;
  els.download.disabled = true;
  updateInviteButtonState();
}

els.join.addEventListener('click', () => {
  const roomId = els.room.value.trim();
  if (!roomId) {
    alert('Вкажіть ID кімнати');
    return;
  }
  if (ws.readyState !== WebSocket.OPEN) {
    alert('WebSocket ще підключається, спробуйте знову за мить.');
    return;
  }
  const displayName = (els.name.value || '').trim();
  if (displayName) {
    try {
      localStorage.setItem('displayName', displayName);
    } catch (err) {
      console.warn('Не вдалося зберегти ім’я у localStorage', err);
    }
  }
  els.join.disabled = true;
  ws.send(JSON.stringify({
    type: 'join',
    roomId,
    displayName: displayName || 'Me',
  }));
  updateInviteButtonState();
});

els.leave.addEventListener('click', () => {
  leaveCall();
});

els.invite.addEventListener('click', () => {
  copyInviteLink();
});

els.mic.addEventListener('click', () => {
  if (!localStream) return;
  const track = localStream.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  els.mic.textContent = track.enabled ? '🎤 Мікрофон вкл' : '🔇 Мікрофон викл';
});

els.cam.addEventListener('click', () => {
  if (!localStream) return;
  const track = localStream.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  els.cam.textContent = track.enabled ? '📷 Камера вкл' : '🚫 Камера викл';
});

els.share.addEventListener('click', async () => {
  if (screenActive || !pc) return;
  try {
    const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const screenTrack = displayStream.getVideoTracks()[0];
    const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
    if (!sender) return;
    await sender.replaceTrack(screenTrack);
    screenActive = true;

    screenTrack.onended = async () => {
      const cameraTrack = localStream?.getVideoTracks()[0];
      if (cameraTrack && sender) {
        await sender.replaceTrack(cameraTrack);
      }
      screenActive = false;
    };
  } catch (err) {
    console.warn('Screen share cancelled', err);
  }
});

els.download.addEventListener('click', () => {
  if (!transcriptLog.length) return;
  const lines = transcriptLog
    .map((item) => `[${new Date(item.ts).toISOString()}] ${item.speaker}: ${item.text}`)
    .join('\n');
  const blob = new Blob([lines], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `transcript_${els.room.value.trim() || 'call'}.txt`;
  a.click();
  URL.revokeObjectURL(url);
});

els.room.addEventListener('input', () => {
  updateInviteButtonState();
  const candidateRoom = joinedRoomId || els.room.value.trim();
  if (candidateRoom) {
    updateHistory(candidateRoom);
  }
});

els.name.addEventListener('blur', () => {
  const displayName = (els.name.value || '').trim();
  try {
    if (displayName) {
      localStorage.setItem('displayName', displayName);
    } else {
      localStorage.removeItem('displayName');
    }
  } catch (err) {
    console.warn('Не вдалося оновити localStorage', err);
  }
  const candidateRoom = joinedRoomId || els.room.value.trim();
  if (candidateRoom) {
    updateHistory(candidateRoom);
  }
});

els.lang.addEventListener('change', () => {
  const candidateRoom = joinedRoomId || els.room.value.trim();
  if (candidateRoom) {
    updateHistory(candidateRoom);
  }
  if (!recognition) return;
  stopLocalSTT();
  startLocalSTT();
});
