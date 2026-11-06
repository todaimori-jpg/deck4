const CONNECT_TIMEOUT = 10000;

function createPeer() {
  if (!window.isSecureContext || !window.RTCPeerConnection) {
    throw new Error('Open this app over HTTPS in a browser with WebRTC.');
  }
  return new RTCPeerConnection({ iceServers: [] });
}

function gatheredDescription(peer) {
  return new Promise((resolve, reject) => {
    function finish(error) {
      clearTimeout(timer);
      peer.removeEventListener('icegatheringstatechange', check);
      if (error) reject(error);
      else resolve(peer.localDescription.toJSON());
    }

    function check() {
      if (peer.iceGatheringState !== 'complete') return;
      const sdp = peer.localDescription?.sdp;
      finish(sdp?.includes('a=candidate:')
        ? null
        : new Error('No local network route found. Check Wi-Fi and try again.'));
    }

    const timer = setTimeout(() => {
      finish(new Error('Wi-Fi pairing timed out. Try again.'));
    }, CONNECT_TIMEOUT);
    peer.addEventListener('icegatheringstatechange', check);
    check();
  });
}

function encode(description) {
  return btoa(JSON.stringify(description));
}

function decode(code, type) {
  try {
    if (code.length > 64000) throw new Error();
    const description = JSON.parse(atob(code.trim()));
    if (description?.type !== type || typeof description.sdp !== 'string') throw new Error();
    return description;
  } catch {
    throw new Error(type === 'answer' ? 'Paste the complete iPhone reply code.' : 'Open a fresh pairing link from the iPad.');
  }
}

function monitor(peer, status, onFailure) {
  peer.addEventListener('connectionstatechange', () => {
    switch (peer.connectionState) {
      case 'connected':
        status.textContent = 'Connected to the cue stream.';
        break;
      case 'disconnected':
        status.textContent = 'Connection interrupted. Waiting for Wi-Fi…';
        break;
      case 'failed':
        onFailure();
        status.textContent = 'Connection failed. Keep both devices on the same Wi-Fi and pair again.';
        break;
    }
  });
}

function setupCopy(button, field, status) {
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(field.value);
      status.textContent = 'Copied.';
    } catch {
      field.focus();
      field.select();
      status.textContent = 'Select and copy the text above.';
    }
  });
}

export function mountPhoneCue(button, startAudio, routeCue) {
  const dialog = document.createElement('dialog');
  dialog.className = 'phone-cue';
  dialog.setAttribute('aria-labelledby', 'phoneCueTitle');
  dialog.innerHTML = `
    <h2 id="phoneCueTitle">iPhone headphones</h2>
    <p>Keep both devices on the same Wi-Fi. Plug headphones into the iPhone before listening.</p>
    <button type="button" data-start>Create pairing link</button>
    <div data-pair hidden>
      <label>Open this link on the iPhone<textarea data-link rows="2" readonly></textarea></label>
      <button type="button" data-copy>Copy link</button>
      <label>Paste the iPhone reply code<textarea data-reply rows="2" spellcheck="false" autocapitalize="none"></textarea></label>
      <button type="button" data-connect>Connect iPhone</button>
    </div>
    <p role="status"></p>
    <button type="button" data-stop disabled>End session</button>
    <button type="button" data-close>Back to decks</button>`;
  document.body.append(dialog);
  const start = dialog.querySelector('[data-start]');
  const pair = dialog.querySelector('[data-pair]');
  const link = dialog.querySelector('[data-link]');
  const reply = dialog.querySelector('[data-reply]');
  const connect = dialog.querySelector('[data-connect]');
  const stop = dialog.querySelector('[data-stop]');
  const status = dialog.querySelector('[role=status]');
  let peer = null;
  let release = null;

  function endSession() {
    const previous = peer;
    peer = null;
    previous?.close();
    release?.();
    release = null;
    pair.hidden = true;
    link.value = '';
    reply.value = '';
    start.disabled = false;
    stop.disabled = true;
    connect.disabled = false;
    button.setAttribute('aria-pressed', 'false');
  }

  button.addEventListener('click', () => dialog.showModal());
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  stop.addEventListener('click', () => {
    endSession();
    status.textContent = 'Cue session ended.';
  });
  setupCopy(dialog.querySelector('[data-copy]'), link, status);

  start.addEventListener('click', async () => {
    let connection;
    try {
      connection = createPeer();
      peer = connection;
      start.disabled = true;
      stop.disabled = false;
      status.textContent = 'Creating the local pairing link…';
      await startAudio();
      if (peer !== connection) return;
      const route = routeCue();
      release = route.release;
      connection.addTrack(route.stream.getAudioTracks()[0], route.stream);
      monitor(connection, status, endSession);
      await connection.setLocalDescription(await connection.createOffer());
      const offer = await gatheredDescription(connection);
      if (peer !== connection) return;
      const receiver = new URL('./phone-cue.html', window.location.href);
      receiver.hash = encode(offer);
      link.value = receiver.href;
      pair.hidden = false;
      button.setAttribute('aria-pressed', 'true');
      status.textContent = 'Open the link on your iPhone, then paste its reply here.';
    } catch (error) {
      if (connection && peer !== connection) return;
      endSession();
      status.textContent = error.message;
    }
  });

  connect.addEventListener('click', async () => {
    const connection = peer;
    if (!connection) return;
    try {
      const answer = decode(reply.value, 'answer');
      connect.disabled = true;
      status.textContent = 'Connecting…';
      await connection.setRemoteDescription(answer);
    } catch (error) {
      if (connection !== peer) return;
      connect.disabled = false;
      status.textContent = error.message;
    }
  });
  window.addEventListener('pagehide', endSession);
}

export function mountCueReceiver() {
  const prepare = document.querySelector('[data-prepare]');
  const reply = document.querySelector('[data-reply]');
  const status = document.querySelector('[role=status]');
  const copy = document.querySelector('[data-copy]');
  const audio = document.querySelector('audio');
  let peer = null;
  const offerCode = location.hash.slice(1);
  setupCopy(copy, reply, status);

  function stop() {
    peer?.close();
    peer = null;
    audio.pause();
    audio.srcObject = null;
    reply.value = '';
    copy.disabled = true;
  }

  prepare.addEventListener('click', async () => {
    try {
      const offer = decode(offerCode, 'offer');
      const connection = createPeer();
      peer = connection;
      prepare.disabled = true;
      status.textContent = 'Preparing your reply code…';
      monitor(connection, status, () => {
        stop();
        prepare.disabled = true;
      });
      connection.addEventListener('track', (event) => {
        audio.srcObject = new MediaStream([event.track]);
      });
      await connection.setRemoteDescription(offer);
      await connection.setLocalDescription(await connection.createAnswer());
      reply.value = encode(await gatheredDescription(connection));
      copy.disabled = false;
      status.textContent = 'Paste this reply on your iPad. After connecting, press play below.';
    } catch (error) {
      stop();
      prepare.disabled = false;
      status.textContent = error.message;
    }
  });
  window.addEventListener('pagehide', stop);
}
