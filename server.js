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

// 테이블 생성
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
    status TEXT DEFAULT 'CLOSED',
    player1_id INTEGER,
    player2_id INTEGER,
    p1_fee INTEGER DEFAULT 1000,
    p2_fee INTEGER DEFAULT 1000,
    winner INTEGER DEFAULT NULL
)`).run();

db.prepare(`CREATE TABLE IF NOT EXISTS bets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    chosen_player INTEGER,
    amount INTEGER
)`).run();

// 상품 테이블 생성
db.prepare(`CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    price INTEGER,
    stock INTEGER
)`).run();

// 초기 설정값 세팅
const initSettings = [
    ['initial_points', '1000'],
    ['win_multiplier', '2'],
    ['lose_multiplier', '0.5'],
    ['draw_multiplier', '1'],
    ['final_multiplier', '1'], // 배팅 정산 최종 배율
    ['store_password', '1234']  // 상품 구매 승인 비밀번호
];
for (let [k, v] of initSettings) {
    const exists = db.prepare("SELECT * FROM settings WHERE key = ?").get(k);
    if (!exists) db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(k, v);
}

const matchExists = db.prepare("SELECT * FROM match_state WHERE id = 1").get();
if (!matchExists) {
    db.prepare("INSERT INTO match_state (id, status) VALUES (1, 'CLOSED')").run();
}

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.set('view engine', 'ejs');

function getSetting(key) {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
    return row ? row.value : null;
}

function getCommonData(currentUser, reqQuery = {}) {
    const usersRaw = db.prepare("SELECT * FROM users WHERE role = 'user'").all();
    const sortType = reqQuery.sort || 'name';
    
    const users = [...usersRaw].sort((a, b) => {
        if (sortType === 'points') {
            return b.points - a.points;
        } else {
            return a.name.localeCompare(b.name, 'ko');
        }
    });

    const settings = {
        initial_points: getSetting('initial_points'),
        win_multiplier: getSetting('win_multiplier'),
        lose_multiplier: getSetting('lose_multiplier'),
        draw_multiplier: getSetting('draw_multiplier'),
        final_multiplier: getSetting('final_multiplier'),
        store_password: getSetting('store_password')
    };

    const match = db.prepare("SELECT * FROM match_state WHERE id = 1").get();
    let p1 = match.player1_id ? db.prepare("SELECT * FROM users WHERE id = ?").get(match.player1_id) : null;
    let p2 = match.player2_id ? db.prepare("SELECT * FROM users WHERE id = ?").get(match.player2_id) : null;

    let totalPool = 0;
    let p1Pool = 0;
    let p2Pool = 0;
    if (match.status === 'BETTING' || match.status === 'CLOSED_BETTING') {
        const bets = db.prepare("SELECT * FROM bets").all();
        bets.forEach(b => {
            totalPool += b.amount;
            if (b.chosen_player === 1) p1Pool += b.amount;
            if (b.chosen_player === 2) p2Pool += b.amount;
        });
    }

    let myBet = null;
    if (currentUser && currentUser.role === 'user') {
        myBet = db.prepare("SELECT * FROM bets WHERE user_id = ?").get(currentUser.id);
    }

    const products = db.prepare("SELECT * FROM products").all();

    return {
        user: currentUser,
        users,
        settings,
        match: { ...match, p1, p2 },
        pool: { total: totalPool, p1: p1Pool, p2: p2Pool },
        myBet,
        sort: sortType,
        products
    };
}

app.get('/', (req, res) => {
    res.render('index', getCommonData(null, req.query));
});

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
        const initPts = parseInt(getSetting('initial_points') || 1000);
        const info = db.prepare("INSERT INTO users (name, password, points, role) VALUES (?, ?, ?, 'user')").run(name, password, initPts);
        const newUser = db.prepare("SELECT * FROM users WHERE id = ?").get(info.lastInsertRowid);
        
        io.emit('refreshData');
        return res.render('index', getCommonData(newUser, req.query));
    }
});

app.post('/admin/update-settings', (req, res) => {
    const { initial_points, win_multiplier, lose_multiplier, draw_multiplier, final_multiplier, store_password } = req.body;
    db.prepare("UPDATE settings SET value = ? WHERE key = 'initial_points'").run(initial_points);
    db.prepare("UPDATE settings SET value = ? WHERE key = 'win_multiplier'").run(win_multiplier);
    db.prepare("UPDATE settings SET value = ? WHERE key = 'lose_multiplier'").run(lose_multiplier);
    db.prepare("UPDATE settings SET value = ? WHERE key = 'draw_multiplier'").run(draw_multiplier);
    db.prepare("UPDATE settings SET value = ? WHERE key = 'final_multiplier'").run(final_multiplier);
    db.prepare("UPDATE settings SET value = ? WHERE key = 'store_password'").run(store_password);
    
    io.emit('refreshData');
    res.redirect('/?admin=1');
});

// 상품 관리: 추가
app.post('/admin/add-product', (req, res) => {
    const { name, price, stock } = req.body;
    db.prepare("INSERT INTO products (name, price, stock) VALUES (?, ?, ?)").run(name, parseInt(price), parseInt(stock));
    io.emit('refreshData');
    res.redirect('/?admin=1');
});

// 상품 관리: 수정
app.post('/admin/update-product', (req, res) => {
    const { productId, name, price, stock } = req.body;
    db.prepare("UPDATE products SET name = ?, price = ?, stock = ? WHERE id = ?").run(name, parseInt(price), parseInt(stock), productId);
    io.emit('refreshData');
    res.redirect('/?admin=1');
});

// 상품 관리: 삭제
app.post('/admin/delete-product', (req, res) => {
    const { productId } = req.body;
    db.prepare("DELETE FROM products WHERE id = ?").run(productId);
    io.emit('refreshData');
    res.redirect('/?admin=1');
});

// 고객 상품 구매 (관리자 비밀번호 승인 방식)
app.post('/user/buy-product', (req, res) => {
    const { userId, productId, password } = req.body;
    const storePwd = getSetting('store_password');

    if (password !== storePwd) {
        return res.send("<script>alert('상품 관리자 비밀번호가 일치하지 않습니다.'); history.back();</script>");
    }

    const product = db.prepare("SELECT * FROM products WHERE id = ?").get(productId);
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);

    if (!product || product.stock <= 0) {
        return res.send("<script>alert('재고가 부족하여 구매할 수 없습니다.'); history.back();</script>");
    }
    if (!user || user.points < product.price) {
        return res.send("<script>alert('보유 포인트가 부족합니다.'); history.back();</script>");
    }

    // 포인트 차감 및 재고 감소
    db.prepare("UPDATE users SET points = points - ? WHERE id = ?").run(product.price, userId);
    db.prepare("UPDATE products SET stock = stock - 1 WHERE id = ?").run(productId);

    io.emit('refreshData');
    res.send("<script>alert('상품 구매가 정상적으로 승인 및 완료되었습니다!'); window.location.href='/';</script>");
});

app.post('/admin/update-points', (req, res) => {
    const { userId, points } = req.body;
    db.prepare("UPDATE users SET points = ? WHERE id = ?").run(points, userId);
    io.emit('refreshData');
    res.redirect('/?admin=1');
});

app.post('/admin/start-match', (req, res) => {
    const { player1_id, player2_id, p1_fee, p2_fee } = req.body;
    if (player1_id === player2_id) {
        return res.send("<script>alert('서로 다른 플레이어를 선택해야 합니다.'); history.back();</script>");
    }

    const p1 = db.prepare("SELECT * FROM users WHERE id = ?").get(player1_id);
    const p2 = db.prepare("SELECT * FROM users WHERE id = ?").get(player2_id);
    const fee1 = parseInt(p1_fee);
    const fee2 = parseInt(p2_fee);

    if (p1.points < fee1) {
        return res.send(`<script>alert('플레이어 1(${p1.name})의 포인트가 부족하여 참가할 수 없습니다. (보유: ${p1.points}P, 필요: ${fee1}P)'); history.back();</script>`);
    }
    if (p2.points < fee2) {
        return res.send(`<script>alert('플레이어 2(${p2.name})의 포인트가 부족하여 참가할 수 없습니다. (보유: ${p2.points}P, 필요: ${fee2}P)'); history.back();</script>`);
    }

    db.prepare("DELETE FROM bets").run();
    db.prepare(`UPDATE match_state SET status = 'BETTING', player1_id = ?, player2_id = ?, p1_fee = ?, p2_fee = ?, winner = NULL WHERE id = 1`).run(
        player1_id, player2_id, fee1, fee2
    );

    db.prepare("UPDATE users SET points = points - ? WHERE id = ?").run(fee1, player1_id);
    db.prepare("UPDATE users SET points = points - ? WHERE id = ?").run(fee2, player2_id);

    io.emit('matchStarted');
    res.redirect('/?admin=1');
});

app.post('/admin/close-betting', (req, res) => {
    const match = db.prepare("SELECT * FROM match_state WHERE id = 1").get();
    if (match.status !== 'BETTING') {
        return res.send("<script>alert('현재 베팅 진행 중인 상태가 아닙니다.'); history.back();</script>");
    }

    db.prepare("UPDATE match_state SET status = 'CLOSED_BETTING' WHERE id = 1").run();
    io.emit('refreshData');
    res.redirect('/?admin=1');
});

// 결과 정산 시 최종 배율(final_multiplier) 반영
app.post('/admin/end-match', (req, res) => {
    const { winner } = req.body; 
    const match = db.prepare("SELECT * FROM match_state WHERE id = 1").get();
    
    if (match.status !== 'CLOSED_BETTING') {
        return res.send("<script>alert('배팅을 먼저 종료한 후에 결과를 확정할 수 있습니다.'); history.back();</script>");
    }

    const winType = parseInt(winner);
    const wMul = parseFloat(getSetting('win_multiplier'));
    const lMul = parseFloat(getSetting('lose_multiplier'));
    const dMul = parseFloat(getSetting('draw_multiplier'));
    const finalMul = parseFloat(getSetting('final_multiplier') || 1); // 최종 배율

    let p1NewPts = 0, p2NewPts = 0;
    if (winType === 1) {
        p1NewPts = Math.floor(match.p1_fee * wMul);
        p2NewPts = Math.floor(match.p2_fee * lMul);
    } else if (winType === 2) {
        p1NewPts = Math.floor(match.p1_fee * lMul);
        p2NewPts = Math.floor(match.p2_fee * wMul);
    } else {
        p1NewPts = Math.floor(match.p1_fee * dMul);
        p2NewPts = Math.floor(match.p2_fee * dMul);
    }

    db.prepare("UPDATE users SET points = points + ? WHERE id = ?").run(p1NewPts, match.player1_id);
    db.prepare("UPDATE users SET points = points + ? WHERE id = ?").run(p2NewPts, match.player2_id);

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
            returnPoints = b.amount;
        } else if (b.chosen_player === winType) {
            if (winnerPool > 0) {
                // 기존 공식에 * final_multiplier 적용
                returnPoints = Math.floor(b.amount * (totalPool / winnerPool) * finalMul);
            } else {
                returnPoints = Math.floor(b.amount * finalMul);
            }
        } else {
            returnPoints = 0;
        }

        if (returnPoints > 0) {
            db.prepare("UPDATE users SET points = points + ? WHERE id = ?").run(returnPoints, b.user_id);
        }
    });

    db.prepare("UPDATE match_state SET status = 'FINISHED', winner = ? WHERE id = 1").run(winType);

    io.emit('matchEnded', { winner: winType });
    res.redirect('/?admin=1');
});

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

    const existingBet = db.prepare("SELECT * FROM bets WHERE user_id = ?").get(userId);
    if (existingBet) {
        return res.send("<script>alert('이미 베팅을 완료하셨습니다. 수정할 수 없습니다.'); history.back();</script>");
    }

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