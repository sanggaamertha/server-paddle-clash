const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

let waitingPlayer = null;
const games = {}; // Objek untuk menyimpan state semua game yang aktif

// --- BAGIAN BARU: KONSTANTA FISIKA DI SERVER ---
const ARENA_WIDTH = 400;
const ARENA_HEIGHT = 800;
const PUCK_RADIUS = 22;
const PADDLE_RADIUS = 85 / 2;
const AIR_FRICTION = 0.992;
const MAX_SPEED = 1600;
const WALL_ENERGY_TRANSFER = 0.94;
const PADDLE_ENERGY_TRANSFER = 1.1; // Sedikit energi tambahan dari paddle

io.on('connection', (socket) => {
  console.log(`Pemain terhubung: ${socket.id}`);

  socket.on('findMatch', () => {
    console.log(`Pemain ${socket.id} mencari pertandingan.`);
    if (waitingPlayer) {
      const player1 = waitingPlayer;
      const player2 = socket;
      const roomId = `game_${player1.id}_${player2.id}`;
      player1.join(roomId);
      player2.join(roomId);

      games[roomId] = {
        roomId: roomId,
        players: {
          [player1.id]: { isPlayer1: true, paddleX: 200, paddleY: 700, paddleVX: 0, paddleVY: 0 },
          [player2.id]: { isPlayer1: false, paddleX: 200, paddleY: 100, paddleVX: 0, paddleVY: 0 },
        },
        puck: { x: 200, y: 400, vx: 150, vy: -150 },
        score: { [player1.id]: 0, [player2.id]: 0 },
      };
      
      io.to(roomId).emit('matchFound', games[roomId]);
      waitingPlayer = null;
    } else {
      waitingPlayer = socket;
      socket.emit('waitingForMatch');
    }
  });

  // <<< DIUBAH >>>: Player move sekarang juga bisa mengirim kecepatan paddle
  socket.on('playerMove', ({ roomId, paddleX, paddleY, paddleVX, paddleVY }) => {
    const game = games[roomId];
    if (game && game.players[socket.id]) {
      game.players[socket.id].paddleX = paddleX;
      game.players[socket.id].paddleY = paddleY;
      game.players[socket.id].paddleVX = paddleVX;
      game.players[socket.id].paddleVY = paddleVY;
    }
  });

  // <<< DIHAPUS >>>: Event 'puckMove' dan 'goalScored' dari klien tidak lagi ada.
  
  socket.on('disconnecting', () => {
    for (const roomId of socket.rooms) {
      if (roomId !== socket.id && games[roomId]) {
        socket.to(roomId).emit('opponentLeft');
        delete games[roomId];
        console.log(`Game ${roomId} dihapus.`);
      }
    }
    if (waitingPlayer && waitingPlayer.id === socket.id) {
        waitingPlayer = null;
    }
  });
  socket.on('disconnect', () => console.log(`Pemain terputus: ${socket.id}`));
});

// --- BAGIAN BARU: GAME LOOP UTAMA SERVER ---
const TICK_RATE = 60;
const MS_PER_TICK = 1000 / TICK_RATE;
const dt = MS_PER_TICK / 1000; // Delta time dalam detik

setInterval(() => {
  for (const roomId in games) {
    const game = games[roomId];
    updateGameState(game, dt);
    io.to(roomId).emit('gameStateUpdate', game);
  }
}, MS_PER_TICK);

// --- BAGIAN BARU: SEMUA FUNGSI FISIKA DI SERVER ---
function updateGameState(game, dt) {
  const { puck, players } = game;
  puck.vx *= AIR_FRICTION;
  puck.vy *= AIR_FRICTION;
  puck.x += puck.vx * dt;
  puck.y += puck.vy * dt;
  handleWallCollisions(puck);
  handlePaddleCollisions(puck, players);

  const speed = Math.sqrt(puck.vx * puck.vx + puck.vy * puck.vy);
  if (speed > MAX_SPEED) {
    puck.vx = (puck.vx / speed) * MAX_SPEED;
    puck.vy = (puck.vy / speed) * MAX_SPEED;
  }
  
  handleGoalScoring(game);
}

function handleWallCollisions(puck) {
    const goalLeftX = ARENA_WIDTH * 0.25;
    const goalRightX = ARENA_WIDTH * 0.75;
    if (puck.x - PUCK_RADIUS <= 0 || puck.x + PUCK_RADIUS >= ARENA_WIDTH) {
        puck.vx *= -WALL_ENERGY_TRANSFER;
        puck.x = puck.x - PUCK_RADIUS <= 0 ? PUCK_RADIUS : ARENA_WIDTH - PUCK_RADIUS;
    }
    if ((puck.y - PUCK_RADIUS <= 0 && (puck.x < goalLeftX || puck.x > goalRightX)) ||
        (puck.y + PUCK_RADIUS >= ARENA_HEIGHT && (puck.x < goalLeftX || puck.x > goalRightX))) {
        puck.vy *= -WALL_ENERGY_TRANSFER;
        puck.y = puck.y - PUCK_RADIUS <= 0 ? PUCK_RADIUS : ARENA_HEIGHT - PUCK_RADIUS;
    }
}

function handlePaddleCollisions(puck, players) {
  for (const playerId in players) {
    const player = players[playerId];
    const dx = puck.x - player.paddleX;
    const dy = puck.y - player.paddleY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const minDistance = PUCK_RADIUS + PADDLE_RADIUS;

    if (distance < minDistance) {
      const normalX = dx / distance;
      const normalY = dy / distance;
      
      const relativeVelX = puck.vx - (player.paddleVX || 0);
      const relativeVelY = puck.vy - (player.paddleVY || 0);
      const speedAlongNormal = relativeVelX * normalX + relativeVelY * normalY;

      if (speedAlongNormal < 0) {
        const impulse = -2 * speedAlongNormal;
        puck.vx += (impulse * normalX) * PADDLE_ENERGY_TRANSFER;
        puck.vy += (impulse * normalY) * PADDLE_ENERGY_TRANSFER;
      }

      puck.x = player.paddleX + normalX * minDistance;
      puck.y = player.paddleY + normalY * minDistance;
    }
  }
}

function handleGoalScoring(game) {
    const { puck, players, score } = game;
    const goalTopY = 10;
    const goalBottomY = ARENA_HEIGHT - 10;
    const goalLeftX = ARENA_WIDTH * 0.25;
    const goalRightX = ARENA_WIDTH * 0.75;
    let scorerId = null;

    if (puck.y < goalTopY && puck.x > goalLeftX && puck.x < goalRightX) {
        scorerId = Object.keys(players).find(id => players[id].isPlayer1);
    } else if (puck.y > goalBottomY && puck.x > goalLeftX && puck.x < goalRightX) {
        scorerId = Object.keys(players).find(id => !players[id].isPlayer1);
    }

    if (scorerId) {
        score[scorerId]++;
        console.log(`Server mendeteksi gol untuk ${scorerId}!`);
        const scorerIsPlayer1 = players[scorerId].isPlayer1;
        puck.x = ARENA_WIDTH / 2;
        puck.y = ARENA_HEIGHT / 2;
        puck.vx = Math.random() > 0.5 ? 150 : -150;
        puck.vy = scorerIsPlayer1 ? -150 : 150;
    }
}

server.listen(PORT, () => {
  console.log(`Dedicated server berjalan di port ${PORT}`);
});