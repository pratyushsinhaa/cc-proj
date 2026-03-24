const leaderEl = document.getElementById('leader');
const connectionEl = document.getElementById('connection');
const canvas = document.getElementById('board');
const clearBtn = document.getElementById('clear');
const colorPicker = document.getElementById('color');
const ctx = canvas.getContext('2d');

let socket;
let connected = false;
let drawing = false;
let pendingPoint = null;
const renderedIndexes = new Set();

function setConnection(text, ok) {
  connectionEl.textContent = text;
  connectionEl.style.color = ok ? '#166534' : '#b91c1c';
}

function fitCanvas() {
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.floor(rect.width * ratio);
  canvas.height = Math.floor(rect.height * ratio);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
}

function drawStroke(op) {
  const payload = op.payload;
  if (!payload || payload.type !== 'segment') {
    return;
  }
  ctx.strokeStyle = payload.color || '#111827';
  ctx.lineWidth = Number(payload.width || 2.5);
  ctx.beginPath();
  ctx.moveTo(payload.from.x, payload.from.y);
  ctx.lineTo(payload.to.x, payload.to.y);
  ctx.stroke();
}

function handleServerMessage(event) {
  let msg;
  try {
    msg = JSON.parse(event.data);
  } catch {
    return;
  }

  if (msg.type === 'LEADER_UPDATE') {
    leaderEl.textContent = msg.leader ? `${msg.leader.id} (term ${msg.leader.term})` : 'None';
  }

  if (msg.type === 'CANVAS_SNAPSHOT') {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    renderedIndexes.clear();
    for (const op of msg.operations || []) {
      drawStroke(op);
      renderedIndexes.add(op.index);
    }
    if (msg.leader) {
      leaderEl.textContent = `${msg.leader.id} (term ${msg.leader.term})`;
    }
  }

  if (msg.type === 'DRAW_COMMITTED') {
    if (!renderedIndexes.has(msg.operation.index)) {
      drawStroke(msg.operation);
      renderedIndexes.add(msg.operation.index);
    }
  }

  if (msg.type === 'ERROR') {
    setConnection(msg.message, false);
    setTimeout(() => {
      if (connected) {
        setConnection('Connected', true);
      }
    }, 1200);
  }
}

function connect() {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const host = window.location.hostname;
  const wsPort = 8080;
  socket = new WebSocket(`${protocol}://${host}:${wsPort}`);

  socket.addEventListener('open', () => {
    connected = true;
    setConnection('Connected', true);
  });

  socket.addEventListener('close', () => {
    connected = false;
    setConnection('Reconnecting...', false);
    setTimeout(connect, 900);
  });

  socket.addEventListener('error', () => {
    connected = false;
    setConnection('Socket error', false);
  });

  socket.addEventListener('message', handleServerMessage);
}

function sendSegment(from, to) {
  if (!connected || !socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(
    JSON.stringify({
      type: 'DRAW',
      payload: {
        type: 'segment',
        from,
        to,
        color: colorPicker.value,
        width: 2.5
      }
    })
  );
}

function pointForEvent(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top
  };
}

canvas.addEventListener('pointerdown', (event) => {
  drawing = true;
  pendingPoint = pointForEvent(event);
});

canvas.addEventListener('pointerup', () => {
  drawing = false;
  pendingPoint = null;
});

canvas.addEventListener('pointerleave', () => {
  drawing = false;
  pendingPoint = null;
});

canvas.addEventListener('pointermove', (event) => {
  if (!drawing || !pendingPoint) {
    return;
  }
  const nextPoint = pointForEvent(event);
  sendSegment(pendingPoint, nextPoint);
  pendingPoint = nextPoint;
});

clearBtn.addEventListener('click', () => {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  renderedIndexes.clear();
});

window.addEventListener('resize', () => {
  fitCanvas();
});

fitCanvas();
connect();
