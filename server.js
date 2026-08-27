const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const dbPath = path.join(__dirname, 'database.sqlite');
const db = new Database(dbPath);

// 1. 테이블 생성 (설정, 사용자, 현재 경기 상태, 고객 베팅 내역)
db.prepare(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`).run();
db.prepare(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    password TEXT,
    points INTEGER,
    role TEXT DEFAULT 'user'
)`).run();

db.prepare(`CREATE TABLE IF NOT EXISTS match_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    status TEXT DEFAULT 'CLOSED', -- CLOSED, BETTING, FINISHED
    player1_id INTEGER,
    player2_id INTEGER,
    p1_fee INTEGER DEFAULT 1000,
    p2_fee INTEGER DEFAULT 1000,
    winner INTEGER DEFAULT NULL -- 1, 2, 0(무승부)
)`).run();

db.prepare(`CREATE TABLE IF NOT EXISTS bets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    chosen_player INTEGER, -- 1 또는 2
    amount INTEGER
)`).run();

// 초기 설정값 세팅 (최초 1회)
const initSettings = [
    ['initial_points', '1000'],
    ['win_multiplier', '2'],
    ['lose_multiplier', '0.5'],
    ['draw_multiplier', '1']
];
for (let [k, v] of initSettings) {
    const exists = db.prepare("SELECT * FROM settings WHERE key = ?").get(k);
    if (!exists) db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(k, v);
}

// 경기 상태 초기화 행 삽입
const matchExists = db.prepare("SELECT * FROM match_state WHERE id = 1").get();
if (!matchExists) {
    db.prepare("INSERT INTO match_state (id, status) VALUES (1, 'CLOSED')").run();
}

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.set('view engine', 'ejs');

// 헬퍼 함수: 설정값 가져오기
function getSetting(key) {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
    return row ? row.value : null;
}

// 공통 데이터 로드 함수 (관리자 및 일반 유저 렌더링용)
function getCommonData(currentUser, reqQuery = {}) {
    const usersRaw = db.prepare("SELECT * FROM users WHERE role = 'user'").all();
    const sortType = reqQuery.sort || 'name';
    
    // 1-1. 정렬 기능 (이름순 vs 포인트 내림차순)
    const users = [...usersRaw].sort((a, b) => {
        if (sortType === 'points') {
            return b.points - a.points; // 포인트 내림차순
        } else {
            return a.name.localeCompare(b.name, 'ko'); // 이름순
        }
    });

    const settings = {
        initial_points: getSetting('initial_points'),
        win_multiplier: getSetting('win_multiplier'),
        lose_multiplier: getSetting('lose_multiplier'),
        draw_multiplier: getSetting('draw_multiplier')
    };

    const match = db.prepare("SELECT * FROM match_state WHERE id = 1").get();
    
    // 플레이어 정보 매핑
    let p1 = match.player1_id ? db.prepare("SELECT * FROM users WHERE id = ?").get(match.player1_id) : null;
    let p2 = match.player2_id ? db.prepare("SELECT * FROM users WHERE id = ?").get(match.player2_id) : null;

    // 베팅 총액 계산
    let totalPool = 0;
    let p1Pool = 0;
    let p2Pool = 0;
    if (match.status === 'BETTING') {
        const bets = db.prepare("SELECT * FROM bets").all();
        bets.forEach(b => {
            totalPool += b.amount;
            if (b.chosen_player === 1) p1Pool += b.amount;
            if (b.chosen_player === 2) p2Pool += b.amount;
        });
    }

    // 현재 접속한 유저의 해당 경기 베팅 정보
    let myBet = null;
    if (currentUser && currentUser.role === 'user') {
        myBet = db.prepare("SELECT * FROM bets WHERE user_id = ?").get(currentUser.id);
    }

    return {
        user: currentUser,
        users,
        settings,
        match: { ...match, p1, p2 },
        pool: { total: totalPool, p1: p1Pool, p2: p2Pool },
        myBet,
        sort: sortType
    };
}

// 라우트: 메인 페이지
app.get('/', (req, res) => {
    res.render('index', getCommonData(null, req.query));
});

// 로그인 및 회원가입
app.post('/login', (req, res) => {
    const { name, password } = req.body;

    if (name === 'Admin' && password === 'whitedog0508') {
        return res.render('index', getCommonData({ name: 'Admin', role: 'admin' }, req.query));
    }

    let row = db.prepare("SELECT * FROM users WHERE name = ?").get(name);
    if (row) {
        if (row.password === password) {
            return res.render('index', getCommonData(row, req.query));
        } else {
            return res.send("<script>alert('비밀번호가 일치하지 않습니다.'); history.back();</script>");
        }
    } else {
        // 계정이 없을 경우 자동 생성 (0번 요구사항: 당시 설정된 initial_points 적용)
        const initPts = parseInt(getSetting('initial_points') || 1000);
        const info = db.prepare("INSERT INTO users (name, password, points, role) VALUES (?, ?, ?, 'user')").run(name, password, initPts);
        const newUser = db.prepare("SELECT * FROM users WHERE id = ?").get(info.lastInsertRowid);
        
        // 실시간 클라이언트 목록 갱신 알림
        io.emit('refreshData');
        return res.render('index', getCommonData(newUser, req.query));
    }
});

// 0번 요구사항: 시스템 설정(배율, 기본포인트 등) 변경
app.post('/admin/update-settings', (req, res) => {
    const { initial_points, win_multiplier, lose_multiplier, draw_multiplier } = req.body;
    db.prepare("UPDATE settings SET value = ? WHERE key = 'initial_points'").run(initial_points);
    db.prepare("UPDATE settings SET value = ? WHERE key = 'win_multiplier'").run(win_multiplier);
    db.prepare("UPDATE settings SET value = ? WHERE key = 'lose_multiplier'").run(lose_multiplier);
    db.prepare("UPDATE settings SET value = ? WHERE key = 'draw_multiplier'").run(draw_multiplier);
    
    io.emit('refreshData');
    res.redirect('/?admin=1');
});

// 1번 요구사항: 관리자의 개별 고객 포인트 직접 수정
app.post('/admin/update-points', (req, res) => {
    const { userId, points } = req.body;
    db.prepare("UPDATE users SET points = ? WHERE id = ?").run(points, userId);
    io.emit('refreshData');
    res.redirect('/?admin=1');
});

// 2번 요구사항: 로봇 결투 시작 (배팅 오픈)
app.post('/admin/start-match', (req, res) => {
    const { player1_id, player2_id, p1_fee, p2_fee } = req.body;
    if (player1_id === player2_id) {
        return res.send("<script>alert('서로 다른 플레이어를 선택해야 합니다.'); history.back();</script>");
    }

    // 기존 베팅 내역 초기화 및 새로운 경기 상태 설정
    db.prepare("DELETE FROM bets").run();
    db.prepare(`UPDATE match_state SET status = 'BETTING', player1_id = ?, player2_id = ?, p1_fee = ?, p2_fee = ?, winner = NULL WHERE id = 1`).run(
        player1_id, player2_id, parseInt(p1_fee), parseInt(p2_fee)
    );

    io.emit('matchStarted');
    res.redirect('/?admin=1');
});

// 2-2 & 3-1 & 3-2 요구사항: 배팅 종료 및 결과 판정 + 포인트 정산
app.post('/admin/end-match', (req, res) => {
    const { winner } = req.body; // '1', '2', '0'(무승부)
    const match = db.prepare("SELECT * FROM match_state WHERE id = 1").get();
    
    if (match.status !== 'BETTING') {
        return res.send("<script>alert('현재 진행 중인 베팅이 없습니다.'); history.back();</script>");
    }

    const winType = parseInt(winner);
    
    // 1. 플레이어 참가비 정산 (2-3 요구사항: 승 X2, 패 X0.5, 무 X1, 소수점 버림)
    const wMul = parseFloat(getSetting('win_multiplier'));
    const lMul = parseFloat(getSetting('lose_multiplier'));
    const dMul = parseFloat(getSetting('draw_multiplier'));

    let p1NewPts = 0, p2NewPts = 0;
    const p1User = db.prepare("SELECT * FROM users WHERE id = ?").get(match.player1_id);
    const p2User = db.prepare("SELECT * FROM users WHERE id = ?").get(match.player2_id);

    if (winType === 1) {
        p1NewPts = Math.floor(match.p1_fee * wMul);
        p2NewPts = Math.floor(match.p2_fee * lMul);
    } else if (winType === 2) {
        p1NewPts = Math.floor(match.p1_fee * lMul);
        p2NewPts = Math.floor(match.p2_fee * wMul);
    } else { // 무승부
        p1NewPts = Math.floor(match.p1_fee * dMul);
        p2NewPts = Math.floor(match.p2_fee * dMul);
    }

    // 플레이어 포인트 반영 (기존 포인트에 정산금 합산 또는 참가비 차감 후 지급 방식 등 기조에 맞게 처리)
    // 여기서는 참가비를 이미 냈다고 가정하고 결과 보상을 지급하거나, 혹은 보상 자체를 포인트로 지급합니다.
    db.prepare("UPDATE users SET points = points + ? WHERE id = ?").run(p1NewPts, match.player1_id);
    db.prepare("UPDATE users SET points = points + ? WHERE id = ?").run(p2NewPts, match.player2_id);

    // 2. 고객 베팅 정산 (3-2 요구사항)
    const bets = db.prepare("SELECT * FROM bets").all();
    let totalPool = 0;
    let winnerPool = 0;

    bets.forEach(b => {
        totalPool += b.amount;
        if (b.chosen_player === winType) {
            winnerPool += b.amount;
        }
    });

    bets.forEach(b => {
        let returnPoints = 0;
        if (winType === 0) {
            // 무승부 시 건 만큼 그대로 반환
            returnPoints = b.amount;
        } else if (b.chosen_player === winType) {
            // 이긴 쪽에 건 경우: (고객이 건 포인트) * (총 배팅금 / 이긴 쪽 총 배팅금)
            if (winnerPool > 0) {
                returnPoints = Math.floor(b.amount * (totalPool / winnerPool));
            } else {
                returnPoints = b.amount; // 예외처리
            }
        } else {
            // 진 쪽에 건 경우 0원 반환 (잃음)
            returnPoints = 0;
        }

        if (returnPoints > 0) {
            db.prepare("UPDATE users SET points = points + ? WHERE id = ?").run(returnPoints, b.user_id);
        }
    });

    // 경기 상태를 FINISHED로 변경
    db.prepare("UPDATE match_state SET status = 'FINISHED', winner = ? WHERE id = 1").run(winType);

    io.emit('matchEnded', { winner: winType });
    res.redirect('/?admin=1');
});

// 3번 요구사항: 고객의 베팅 참여 (한 플레이어에게만 가능)
app.post('/user/place-bet', (req, res) => {
    const { userId, chosenPlayer, amount } = req.body;
    const betAmount = parseInt(amount);

    const match = db.prepare("SELECT * FROM match_state WHERE id = 1").get();
    if (match.status !== 'BETTING') {
        return res.send("<script>alert('현재 베팅 가능한 시간이 아닙니다.'); history.back();</script>");
    }

    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
    if (!user || user.points < betAmount) {
        return res.send("<script>alert('보유 포인트가 부족합니다.'); history.back();</script>");
    }

    // 이미 베팅했는지 확인
    const existingBet = db.prepare("SELECT * FROM bets WHERE user_id = ?").get(userId);
    if (existingBet) {
        return res.send("<script>alert('이미 베팅을 완료하셨습니다. 수정할 수 없습니다.'); history.back();</script>");
    }

    // 포인트 차감 및 베팅 기록 생성
    db.prepare("UPDATE users SET points = points - ? WHERE id = ?").run(betAmount, userId);
    db.prepare("INSERT INTO bets (user_id, chosen_player, amount) VALUES (?, ?, ?)").run(userId, parseInt(chosenPlayer), betAmount);

    io.emit('refreshData');
    res.redirect('/');
});

io.on('connection', (socket) => {
    console.log('클라이언트 연결됨');
});

server.listen(3000, () => {
    console.log('서버 실행 중: http://localhost:3000');
});