// server.js (Versi 1v1 dengan Aksi Pemain)
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

const ARENA_WIDTH = 1000;
const ARENA_HEIGHT = 500;
const BALL_RADIUS = 20;
const PLAYER_RADIUS = 30;
const MAX_PLAYER_SPEED = 300;
const SLIDE_SPEED = 800;
const SLIDE_DURATION = 250; // ms

io.on("connection", (socket) => {
    console.log(`Pemain terhubung: ${socket.id}`);

    socket.on("findMatch", () => {
        if (waitingPlayer) {
            const player1Socket = waitingPlayer;
            const player2Socket = socket;
            const roomId = `game_${player1Socket.id}_${player2Socket.id}`;

            player1Socket.join(roomId);
            player2Socket.join(roomId);
            waitingPlayer = null;

            const gameState = {
                roomId,
                players: {
                    [player1Socket.id]: {
                        id: player1Socket.id, isPlayer1: true,
                        x: ARENA_WIDTH * 0.25, y: ARENA_HEIGHT / 2,
                        vx: 0, vy: 0, isSliding: false, slideTimer: 0,
                    },
                    [player2Socket.id]: {
                        id: player2Socket.id, isPlayer1: false,
                        x: ARENA_WIDTH * 0.75, y: ARENA_HEIGHT / 2,
                        vx: 0, vy: 0, isSliding: false, slideTimer: 0,
                    }
                },
                ball: { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2, vx: 0, vy: 0, possessedBy: null },
                score: { [player1Socket.id]: 0, [player2Socket.id]: 0 },
                lastUpdate: Date.now(),
            };

            games[roomId] = gameState;
            io.to(player1Socket.id).emit("matchFound", { ...gameState, myId: player1Socket.id });
            io.to(player2Socket.id).emit("matchFound", { ...gameState, myId: player2Socket.id });
            console.log(`Game 1v1 dimulai di room ${roomId}`);
        } else {
            waitingPlayer = socket;
            socket.emit("statusUpdate", { status: 'waiting' });
        }
    });

    socket.on("playerMove", ({ roomId, vx, vy }) => {
        const game = games[roomId];
        const player = game?.players[socket.id];
        if (player && !player.isSliding) {
            player.vx = vx;
            player.vy = vy;
        }
    });
    
    // TAMBAHKAN KEMBALI LOGIKA AKSI INI
    socket.on("playerAction", ({ roomId, action, charge }) => {
       const game = games[roomId];
       const player = game?.players[socket.id];
       if (!player) return;

       if (action === 'slide' && !player.isSliding) {
           player.isSliding = true;
           player.slideTimer = SLIDE_DURATION;
           // Gunakan arah gerak terakhir, atau ke depan jika diam
           const moveDirection = Math.sqrt(player.vx**2 + player.vy**2) > 0 ? {x: player.vx, y: player.vy} : {x: player.isPlayer1 ? 1 : -1, y: 0};
           player.vx = moveDirection.x;
           player.vy = moveDirection.y;
       } else if (action === 'shoot' && game.ball.possessedBy === socket.id) {
           const { ball } = game;
           ball.possessedBy = null;
           const shootStrength = 250 + ((charge || 0.5) * 1200); // charge (0-1)
           
           let shootDirX = player.vx;
           let shootDirY = player.vy;
           
           if (shootDirX === 0 && shootDirY === 0) {
               shootDirX = player.isPlayer1 ? 1 : -1;
           }

           const magnitude = Math.sqrt(shootDirX**2 + shootDirY**2) || 1;
           ball.vx = (shootDirX / magnitude) * shootStrength;
           ball.vy = (shootDirY / magnitude) * shootStrength;
       }
    });

    socket.on("disconnecting", () => {
        if (waitingPlayer?.id === socket.id) waitingPlayer = null;
        for (const roomId of socket.rooms) {
            if (roomId !== socket.id && games[roomId]) {
                io.to(roomId).emit("statusUpdate", { status: 'opponentLeft' });
                delete games[roomId];
            }
        }
    });
});

function gameLoop() {
    for (const roomId in games) {
        const game = games[roomId];
        const now = Date.now();
        const dt = (now - game.lastUpdate) / 1000;

        for (const playerId in game.players) {
            updatePlayer(game.players[playerId], dt);
        }
        updateBall(game);

        game.lastUpdate = now;
        io.to(roomId).emit("gameStateUpdate", game);
    }
}

function updatePlayer(player, dt) {
    const speed = player.isSliding ? SLIDE_SPEED : MAX_PLAYER_SPEED;
    player.x += player.vx * speed * dt;
    player.y += player.vy * speed * dt;
    player.x = Math.max(PLAYER_RADIUS, Math.min(ARENA_WIDTH - PLAYER_RADIUS, player.x));
    player.y = Math.max(PLAYER_RADIUS, Math.min(ARENA_HEIGHT - PLAYER_RADIUS, player.y));
    
    if (player.isSliding) {
        player.slideTimer -= dt * 1000;
        if (player.slideTimer <= 0) {
            player.isSliding = false;
            player.vx = 0;
            player.vy = 0;
        }
    }
}

function updateBall(game) {
    const { ball, players } = game;

    if (ball.possessedBy) {
        const owner = players[ball.possessedBy];
        if (owner) {
            const forwardX = owner.isPlayer1 ? 1 : -1;
            ball.x = owner.x + (forwardX * (PLAYER_RADIUS + 5));
            ball.y = owner.y;
            ball.vx = 0; ball.vy = 0;
        } else {
             ball.possessedBy = null;
        }
    } else {
        // Logika fisika bola bebas bisa ditambahkan di sini
        for (const playerId in players) {
            const player = players[playerId];
            const dist = Math.sqrt((ball.x - player.x)**2 + (ball.y - player.y)**2);
            if (dist < PLAYER_RADIUS + BALL_RADIUS) {
                ball.possessedBy = playerId;
            }
        }
    }

    const goalLineLeft = 20, goalLineRight = ARENA_WIDTH - 20;
    const goalTopY = ARENA_HEIGHT * 0.25, goalBottomY = ARENA_HEIGHT * 0.75;
    let scorerId = null;
    if (ball.x < goalLineLeft && ball.y > goalTopY && ball.y < goalBottomY) scorerId = Object.keys(players).find(id => !players[id].isPlayer1);
    else if (ball.x > goalLineRight && ball.y > goalTopY && ball.y < goalBottomY) scorerId = Object.keys(players).find(id => players[id].isPlayer1);
    
    if (scorerId) {
        game.score[scorerId]++;
        ball.x = ARENA_WIDTH / 2; ball.y = ARENA_HEIGHT / 2;
        ball.vx = 0; ball.vy = 0; ball.possessedBy = null;
    }
}

setInterval(gameLoop, 1000 / 60);
server.listen(PORT, () => console.log(`Server 1v1 dengan aksi berjalan di port ${PORT}`));