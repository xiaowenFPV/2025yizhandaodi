const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};
let nextPlayerId = 0;

// === 决斗题库 ===
const duelQuestionBank = [
  { q: "地球上最大的海洋是？", a: "太平洋" },
  { q: "光年是什么的单位？", a: "距离" },
  { q: "人体最大的器官是？", a: "皮肤" },
  { q: "太阳系中最大的行星是？", a: "木星" },
  { q: "水的化学式是什么？", a: "H2O" },
  { q: "中国最长的河流是？", a: "长江" },
  { q: "世界上最高的山峰是？", a: "珠穆朗玛峰" },
  { q: "一年有多少天？", a: "365" },
  { q: "地球绕太阳一周需要多长时间？", a: "一年" },
  { q: "人体有多少块骨头？", a: "206" },
  { q: "声音在真空中能传播吗？", a: "不能" },
  { q: "铁生锈需要什么条件？", a: "水和氧气" },
  { q: "中国的首都是？", a: "北京" },
  { q: "世界上最小的国家是？", a: "梵蒂冈" },
  { q: "DNA的中文名称是？", a: "脱氧核糖核酸" },
  { q: "地球的卫星是？", a: "月球" },
  { q: "世界上最长的城墙是？", a: "长城" },
  { q: "1公里等于多少米？", a: "1000" },
  { q: "冰融化变成什么？", a: "水" },
  { q: "中国有多少个民族？", a: "56" },
  { q: "人体正常体温是多少摄氏度？", a: "37" },
  { q: "《红楼梦》的作者是？", a: "曹雪芹" },
  { q: "地球自转一周需要多长时间？", a: "一天" },
  { q: "氧气占空气体积的百分之多少？", a: "21" },
  { q: "世界上最大的沙漠是？", a: "撒哈拉沙漠" },
  { q: "中国最大的岛屿是？", a: "台湾岛" },
  { q: "光的速度约为每秒多少公里？", a: "30万" },
  { q: "人体最硬的物质是？", a: "牙釉质" },
  { q: "世界杯足球赛几年举办一次？", a: "4" },
  { q: "中国农历有多少个节气？", a: "24" },
  { q: "被誉为万园之园的是？", a: "圆明园" },
  { q: "三国演义中桃园三结义不包括谁？", a: "曹操" },
  { q: "计算机的CPU中文名叫什么？", a: "中央处理器" },
  { q: "地球上最大的动物是？", a: "蓝鲸" },
  { q: "奥运会几年举办一次？", a: "4" },
  { q: "人体最小的骨头在哪个部位？", a: "耳朵" },
  { q: "中国四大发明不包括哪一个？", a: "造纸术" },
  { q: "马拉松全程约多少公里？", a: "42" },
  { q: "QQ的谐音是什么？", a: "求求" },
  { q: "一打是多少个？", a: "12" },
];

function getRandomDuelQuestions(count) {
  const shuffled = [...duelQuestionBank].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

function generateRoomCode() {
  const chars = '0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function createRoom(hostId, hostName) {
  let code;
  do { code = generateRoomCode(); } while (rooms[code]);
  const pid = ++nextPlayerId;
  rooms[code] = {
    code,
    hostSocketId: hostId,
    players: [{ id: pid, socketId: hostId, name: hostName, score: 0, answers: [], connected: true, ready: false }],
    state: 'waiting',
    questionCount: 0,
    questions: [],
    currentRound: 0,
    totalPlayers: 1,
  };
  return { code, pid };
}

io.on('connection', (socket) => {
  console.log(`[连接] ${socket.id}`);

  // === 创建房间 ===
  socket.on('createRoom', (playerName, callback) => {
    // 兼容客户端发送对象格式（如 duel 模式传来的 { name, gameMode }）
    if (!callback && typeof playerName === 'object') {
      const arr = Array.isArray(playerName) ? playerName : [playerName];
      playerName = arr[0];
      callback = arr[arr.length - 1];
    }
    // 兼容 playerName 是对象但 callback 已传入的情况（duel 模式）
    if (typeof playerName === 'object' && playerName !== null && playerName.name) {
      playerName = playerName.name;
    }
    if (typeof callback !== 'function') { console.error('[创建] callback 无效'); return; }
    const { code, pid } = createRoom(socket.id, playerName);
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.playerId = pid;
    console.log(`[房间] ${code} 创建，房主: ${playerName} (${pid})`);

    // 广播玩家列表给房中所有人（格式匹配客户端 data.players 预期）
    const room = rooms[code];
    const playerListData = { players: room.players.map(p => ({
      id: p.id, name: p.name, score: p.score, isHost: p.socketId === room.hostSocketId, ready: p.ready
    })) };
    io.to(code).emit('playerList', playerListData);

    callback({ success: true, roomCode: code, playerId: pid, players: room.players });
  });

  // === 加入房间 ===
  socket.on('joinRoom', (roomCode, playerName, callback) => {
    // 兼容 Socket.IO 多参数打包
    if (!callback && !playerName && typeof roomCode === 'object') {
      const arr = Array.isArray(roomCode) ? roomCode : [roomCode];
      roomCode = String(arr[0] || '');
      playerName = arr[1];
      callback = arr[2];
    }
    if (typeof callback !== 'function') { console.error('[加入] callback 无效'); return; }
    if (!roomCode || typeof roomCode !== 'string') {
      return callback({ success: false, error: '房间号格式错误' });
    }
    const room = rooms[roomCode];
    if (!room) return callback({ success: false, error: '房间不存在' });
    if (room.state !== 'waiting') return callback({ success: false, error: '游戏已开始' });

    const pid = ++nextPlayerId;
    socket.join(roomCode);
    room.players.push({
      id: pid, socketId: socket.id, name: playerName,
      score: 0, answers: [], connected: true, ready: false
    });
    socket.data.roomCode = roomCode;
    socket.data.playerId = pid;

    console.log(`[房间] ${roomCode} 加入: ${playerName} (${pid})，共 ${room.players.length} 人`);

    // 广播更新后的玩家列表（格式匹配客户端 data.players 预期）
    io.to(roomCode).emit('playerList', { players: room.players.map(p => ({
      id: p.id, name: p.name, score: p.score, isHost: p.socketId === room.hostSocketId, ready: p.ready
    })) });

    callback({ success: true, playerId: pid, players: room.players });
  });
  // ============ 1v1 决斗事件 ============

  socket.on('duelReady', () => {
    const code = socket.data.roomCode;
    const playerId = socket.data.playerId;
    const room = rooms[code];
    if (!room) return;
    const player = room.players.find(p => p.id === playerId);
    if (!player) return;
    player.ready = true;
    console.log(`[决斗] ${code} ${player.name} 已准备`);
    socket.to(code).emit('duelReadyStatus', { playerId, ready: true });

    const allReady = room.players.length >= 2 && room.players.every(p => p.ready);
    if (allReady && room.state === 'waiting') {
      room.state = 'duel_countdown';
      io.to(code).emit('duelCountdown');
      console.log(`[决斗] ${code} 双方就绪，5秒后开始`);
      setTimeout(() => {
        if (!rooms[code] || room.state !== 'duel_countdown') return;
        startDuelGame(room, code);
      }, 5000);
    }
  });

  socket.on('duelUnready', () => {
    const code = socket.data.roomCode;
    const playerId = socket.data.playerId;
    const room = rooms[code];
    if (!room) return;
    const player = room.players.find(p => p.id === playerId);
    if (!player) return;
    player.ready = false;
    socket.to(code).emit('duelReadyStatus', { playerId, ready: false });
  });

  socket.on('duelAnswer', (data) => {
    const code = socket.data.roomCode;
    const playerId = socket.data.playerId;
    const room = rooms[code];
    if (!room || room.state !== 'duel_playing') return;

    if (room.duelRoundTimeout) {
      clearTimeout(room.duelRoundTimeout);
      room.duelRoundTimeout = null;
    }

    if (!room.duelFirstAnswerer) {
      // 首位作答
      room.duelFirstAnswerer = playerId;
      room.duelFirstAnswer = data.answer;
      room.duelFirstCorrect = data.isCorrect;
      room.duelFirstAnswerTime = Date.now();

      if (data.isCorrect) {
        resolveDuelRound(room, code, playerId);
      } else {
        io.to(code).emit('duelFirstWrong', {
          playerId, answer: data.answer, correctAnswer: data.correctAnswer
        });
        room.duelRoundTimeout = setTimeout(() => {
          resolveDuelRound(room, code, null);
        }, 30000);
      }
    } else if (playerId !== room.duelFirstAnswerer) {
      // 第二位作答
      if (data.isCorrect) {
        resolveDuelRound(room, code, playerId);
      } else {
        resolveDuelRound(room, code, null); // 两人都错 → 作废
      }
    }
  });

  // ============ 决斗辅助函数（作用域内） ============

  function startDuelGame(room, code) {
    const questions = getRandomDuelQuestions(15);
    room.state = 'duel_playing';
    room.duelQuestions = questions;
    room.duelCurrentRound = 0;
    room.duelWins = {};
    room.players.forEach(p => { room.duelWins[p.id] = 0; });
    room.duelRoundHistory = [];
    room.duelFirstAnswerer = null;
    room.duelFirstAnswer = null;
    room.duelFirstCorrect = null;

    io.to(code).emit('duelStart');
    console.log(`[决斗] ${code} 开始，${questions.length} 题`);
    sendDuelRound(room, code);
  }

  function sendDuelRound(room, code) {
    const q = room.duelQuestions[room.duelCurrentRound];
    if (!q) return;
    room.duelFirstAnswerer = null;
    room.duelFirstAnswer = null;
    room.duelFirstCorrect = null;
    room.duelFirstAnswerTime = null;

    const wins = room.players.map(p => ({ id: p.id, wins: room.duelWins[p.id] }));
    io.to(code).emit('duelRound', {
      question: q,
      roundIndex: room.duelCurrentRound,
      wins
    });

    // 30秒超时
    if (room.duelRoundTimeout) clearTimeout(room.duelRoundTimeout);
    room.duelRoundTimeout = setTimeout(() => {
      io.to(code).emit('duelTimeout');
      // 超时后再给 3 秒缓冲
      setTimeout(() => {
        if (room.state !== 'duel_playing') return;
        if (!room.duelFirstAnswerer) {
          resolveDuelRound(room, code, null);
        }
      }, 3000);
    }, 30000);
  }

  function resolveDuelRound(room, code, winnerId) {
    if (room.duelRoundTimeout) {
      clearTimeout(room.duelRoundTimeout);
      room.duelRoundTimeout = null;
    }

    const q = room.duelQuestions[room.duelCurrentRound];
    const isVoid = winnerId === null;
    const firstAnswererId = room.duelFirstAnswerer;
    const firstAnswer = room.duelFirstAnswer;
    const firstCorrect = room.duelFirstCorrect;

    if (!isVoid && winnerId) {
      room.duelWins[winnerId] = (room.duelWins[winnerId] || 0) + 1;
    }

    // 记录对局历史
    room.duelRoundHistory.push({
      roundIndex: room.duelCurrentRound,
      winnerId: isVoid ? null : winnerId,
      questionText: q ? q.q : ''
    });

    const wins = room.players.map(p => ({ id: p.id, wins: room.duelWins[p.id] }));
    const maxWins = Math.max(...Object.values(room.duelWins));
    const totalRounds = room.duelQuestions.length;
    const gameOver = maxWins >= 8 || room.duelCurrentRound >= totalRounds - 1;

    io.to(code).emit('duelRoundResult', {
      roundIndex: room.duelCurrentRound,
      correctAnswer: q ? q.a : '',
      winnerId: isVoid ? null : winnerId,
      firstAnswererId: isVoid ? firstAnswererId : null,
      firstAnswer: isVoid ? firstAnswer : null,
      firstCorrect: isVoid ? firstCorrect : null,
      wins,
      gameOver,
      void: isVoid
    });

    if (gameOver) {
      const sorted = [...room.players].sort((a, b) => (room.duelWins[b.id] || 0) - (room.duelWins[a.id] || 0));
      setTimeout(() => {
        room.state = 'finished';
        io.to(code).emit('duelOver', {
          ranking: sorted.map((p, i) => ({
            id: p.id, name: p.name, wins: room.duelWins[p.id], rank: i + 1
          })),
          roundHistory: room.duelRoundHistory
        });
      }, 3000);
    } else {
      room.duelCurrentRound++;
      setTimeout(() => {
        if (room.state !== 'duel_playing') return;
        sendDuelRound(room, code);
      }, 3500);
    }
  }

  // === 断线 ===
  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    const playerId = socket.data.playerId;
    if (!code || !rooms[code]) return;

    const room = rooms[code];
    const player = room.players.find(p => p.id === playerId);
    if (player) player.connected = false;

    // 清理决斗定时器
    if (room.duelRoundTimeout) {
      clearTimeout(room.duelRoundTimeout);
      room.duelRoundTimeout = null;
    }

    const leftPlayers = room.players.filter(p => p.connected);
    socket.to(code).emit('playerDisconnected', {
      playerId, playerName: player ? player.name : '未知',
      playerList: leftPlayers.map(p => ({ id: p.id, name: p.name, score: p.score, isHost: p.socketId === room.hostSocketId, ready: p.ready }))
    });

    // 如果全部断开，清理房间
    if (leftPlayers.length === 0) {
      delete rooms[code];
      console.log(`[清理] 房间 ${code} 已移除`);
    }

    console.log(`[断开] ${player ? player.name : '?'} (${socket.id})`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`服务运行在 http://localhost:${PORT}`);
});
