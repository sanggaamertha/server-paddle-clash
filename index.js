const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

let waitingPlayer = null;
const games = {};

// --- KONSTANTA BARU ---
const WINNING_SCORE = 10;
const COUNTDOWN_SECONDS = 3; // Termasuk angka 3, 2, 1

// --- KONSTANTA FISIKA (tetap sama) ---
const ARENA_WIDTH = 400;
const ARENA_HEIGHT = 800;
const PUCK_RADIUS = 22;
const PADDLE_RADIUS = 85 / 2;
const AIR_FRICTION = 0.992;
const MAX_SPEED = 1600;
const WALL_ENERGY_TRANSFER = 0.94;
const PADDLE_ENERGY_TRANSFER = 1.1;

// Fungsi untuk memulai timer bot
function startBotMatchTimer(socket) {
  const delay = Math.random() * (19000 - 10000) + 10000; // Random 10-19 detik
  console.log(
    `Pemain ${socket.id} menunggu. Timer bot diatur untuk ${Math.round(
      delay / 1000
    )} detik.`
  );

  const timer = setTimeout(() => {
    // Cek jika pemain masih menunggu
    if (waitingPlayer && waitingPlayer.socket.id === socket.id) {
      console.log(`Waktu tunggu habis! Mencarikan bot untuk ${socket.id}.`);
      matchWithBot(socket);
    }
  }, delay);

  waitingPlayer = { socket: socket, timer: timer };
}

// Fungsi untuk membuat game melawan bot
function matchWithBot(playerSocket) {
  const botId = `bot_${playerSocket.id}`;
  const roomId = `game_bot_${playerSocket.id}`;

  playerSocket.join(roomId);

  games[roomId] = {
    roomId: roomId,
    isBotGame: true, // Tandai ini sebagai game bot
    players: {
      [playerSocket.id]: {
        isPlayer1: true,
        paddleX: 200,
        paddleY: 700,
        paddleVX: 0,
        paddleVY: 0,
      },
      [botId]: {
        isPlayer1: false,
        paddleX: 200,
        paddleY: 100,
        paddleVX: 0,
        paddleVY: 0,
        isBot: true,
      },
    },
    puck: { x: 200, y: 400, vx: 0, vy: 0, isFrozen: true }, // Mulai dengan bola beku
    score: { [playerSocket.id]: 0, [botId]: 0 },
    countdown: COUNTDOWN_SECONDS,
  };

  io.to(roomId).emit("matchFound", games[roomId]);
  waitingPlayer = null; // Hapus dari antrian
}

io.on("connection", (socket) => {
  console.log(`Pemain terhubung: ${socket.id}`);

  socket.on("findMatch", () => {
    if (waitingPlayer) {
      clearTimeout(waitingPlayer.timer); // Batalkan timer bot
      const player1 = waitingPlayer.socket;
      const player2 = socket;
      const roomId = `game_${player1.id}_${player2.id}`;
      player1.join(roomId);
      player2.join(roomId);

      games[roomId] = {
        roomId: roomId,
        isBotGame: false,
        players: {
          [player1.id]: {
            isPlayer1: true,
            paddleX: 200,
            paddleY: 700,
            paddleVX: 0,
            paddleVY: 0,
          },
          [player2.id]: {
            isPlayer1: false,
            paddleX: 200,
            paddleY: 100,
            paddleVX: 0,
            paddleVY: 0,
          },
        },
        puck: { x: 200, y: 400, vx: 0, vy: 0, isFrozen: true }, // Mulai dengan bola beku
        score: { [player1.id]: 0, [player2.id]: 0 },
        countdown: COUNTDOWN_SECONDS,
      };

      io.to(roomId).emit("matchFound", games[roomId]);
      waitingPlayer = null;
    } else {
      startBotMatchTimer(socket);
      socket.emit("waitingForMatch");
    }
  });

  socket.on(
    "playerMove",
    ({ roomId, paddleX, paddleY, paddleVX, paddleVY }) => {
      const game = games[roomId];
      if (game && game.players[socket.id]) {
        game.players[socket.id].paddleX = paddleX;
        game.players[socket.id].paddleY = paddleY;
        game.players[socket.id].paddleVX = paddleVX;
        game.players[socket.id].paddleVY = paddleVY;
      }
    }
  );

  socket.on("disconnecting", () => {
    for (const roomId of socket.rooms) {
      if (roomId !== socket.id && games[roomId]) {
        socket.to(roomId).emit("opponentLeft");
        delete games[roomId];
      }
    }
    if (waitingPlayer && waitingPlayer.socket.id === socket.id) {
      clearTimeout(waitingPlayer.timer);
      waitingPlayer = null;
    }
  });
  socket.on("disconnect", () => console.log(`Pemain terputus: ${socket.id}`));
});

const TICK_RATE = 60;
const MS_PER_TICK = 1000 / TICK_RATE;

setInterval(() => {
  for (const roomId in games) {
    const game = games[roomId];
    const dt = MS_PER_TICK / 1000;

    if (game.isBotGame) {
      updateBotPaddle(game, dt);
    }

    if (game.puck.isFrozen) {
      // Logika countdown
      if (!game.puck.countdownStarted) {
        game.puck.countdownStarted = true;
        let count = game.countdown;
        const countdownInterval = setInterval(() => {
          if (games[roomId]) {
            // Pastikan game masih ada
            games[roomId].countdown = count;
            if (count > 0) {
              count--;
            } else {
              // Countdown selesai, mulai permainan
              games[roomId].puck.isFrozen = false;
              games[roomId].puck.countdownStarted = false;
              const scorerIsPlayer1 = game.lastScorer
                ? games[roomId].players[game.lastScorer].isPlayer1
                : Math.random() > 0.5;
              games[roomId].puck.vx = Math.random() > 0.5 ? 150 : -150;
              games[roomId].puck.vy = scorerIsPlayer1 ? -150 : 150;
              delete games[roomId].countdown;
              clearInterval(countdownInterval);
            }
          } else {
            clearInterval(countdownInterval);
          }
        }, 1000);
      }
    } else {
      // Fisika normal
      updateGameState(game, dt);
    }

    io.to(roomId).emit("gameStateUpdate", game);
  }
}, MS_PER_TICK);

function updateBotPaddle(game, dt) {
  const { puck, players } = game;
  const botId = Object.keys(players).find((id) => players[id].isBot);
  const bot = players[botId];

  // AI Sederhana tapi Cukup Sulit
  // Target X bot adalah posisi X puck, tapi ada sedikit error/delay
  let targetX = puck.x;

  // Prediksi di mana puck akan berada
  if (puck.vy < 0) {
    // Puck bergerak ke arah bot
    const timeToReach = Math.abs((bot.paddleY - puck.y) / puck.vy);
    targetX = puck.x + puck.vx * timeToReach;
  }

  // Batasi target agar tidak keluar arena
  targetX = Math.max(
    PADDLE_RADIUS,
    Math.min(ARENA_WIDTH - PADDLE_RADIUS, targetX)
  );

  // Gerakkan paddle bot menuju target dengan kecepatan tertentu
  const speed = 250; // Kecepatan gerak bot
  const dx = targetX - bot.paddleX;
  if (Math.abs(dx) > 1) {
    bot.paddleX += Math.sign(dx) * speed * dt;
  }
}

function handleGoalScoring(game) {
  const { puck, players, score } = game;
  // ... (kode deteksi gawang sama persis seperti sebelumnya) ...
  const goalTopY = 10,
    goalBottomY = ARENA_HEIGHT - 10,
    goalLeftX = ARENA_WIDTH * 0.25,
    goalRightX = ARENA_WIDTH * 0.75;
  let scorerId = null;
  if (puck.y < goalTopY && puck.x > goalLeftX && puck.x < goalRightX)
    scorerId = Object.keys(players).find((id) => players[id].isPlayer1);
  else if (puck.y > goalBottomY && puck.x > goalLeftX && puck.x < goalRightX)
    scorerId = Object.keys(players).find((id) => !players[id].isPlayer1);

  if (scorerId) {
    score[scorerId]++;
    game.lastScorer = scorerId;

    // Cek Pemenang
    if (score[scorerId] >= WINNING_SCORE) {
      io.to(game.roomId).emit("gameOver", { winnerId: scorerId, score: score });
      delete games[game.roomId]; // Hapus game setelah selesai
      return;
    }

    // --- ATUR ULANG PUCKK BARU ---
    const loserIsPlayer1 = !players[scorerId].isPlayer1;
    puck.isFrozen = true;
    puck.x = ARENA_WIDTH / 2;
    // Posisikan puck lebih dekat ke arah yang kalah
    puck.y = loserIsPlayer1 ? ARENA_HEIGHT / 2 + 100 : ARENA_HEIGHT / 2 - 100;
    puck.vx = 0;
    puck.vy = 0;
    game.countdown = COUNTDOWN_SECONDS; // Mulai lagi countdown
  }
}

// Fungsi updateGameState, handleWallCollisions, handlePaddleCollisions sama seperti sebelumnya
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
    puck.x =
      puck.x - PUCK_RADIUS <= 0 ? PUCK_RADIUS : ARENA_WIDTH - PUCK_RADIUS;
  }
  if (
    (puck.y - PUCK_RADIUS <= 0 &&
      (puck.x < goalLeftX || puck.x > goalRightX)) ||
    (puck.y + PUCK_RADIUS >= ARENA_HEIGHT &&
      (puck.x < goalLeftX || puck.x > goalRightX))
  ) {
    puck.vy *= -WALL_ENERGY_TRANSFER;
    puck.y =
      puck.y - PUCK_RADIUS <= 0 ? PUCK_RADIUS : ARENA_HEIGHT - PUCK_RADIUS;
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
        puck.vx += impulse * normalX * PADDLE_ENERGY_TRANSFER;
        puck.vy += impulse * normalY * PADDLE_ENERGY_TRANSFER;
      }

      puck.x = player.paddleX + normalX * minDistance;
      puck.y = player.paddleY + normalY * minDistance;
    }
  }
}

server.listen(PORT, () =>
  console.log(`Dedicated server berjalan di port ${PORT}`)
);
