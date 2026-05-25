// ==UserScript==
// @name         Potok Cash Bonus Keeper [growing]
// @namespace    https://potok.cash/cabinet
// @version      20260525054846
// @description  Automation for pressing bonus button each 24 hours
// @author       https://github.com/valpolik/potok-cash-growing-flow-24h-automation
// @match        https://potok.cash/cabinet
// @icon         https://www.google.com/s2/favicons?sz=64&domain=potok.cash
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // ---------- НАСТРОЙКА: укажите нужный бонус ----------
    const PROGRAM = 'growing';   // ← меняйте при копировании

    const tabId = Math.random().toString(36).substring(2) + Date.now().toString(36);
    console.log(`🆔 Вкладка [${PROGRAM}] инициализирована, ID: ${tabId}`);

    // Уникальный канал для этого бонуса
    const channel = new BroadcastChannel(`potok-bonus-channel-${PROGRAM}`);

    let isLeader = false;
    let currentTimer = null;
    let retryTimer = null;
    let heartbeatInterval = null;
    let lastHeartbeat = Date.now();
    let recognizedLeaderId = null;

    // Локальная переменная вместо window._myLeaderTime
    let myLeaderTime = Date.now();

    function getUid() {
        if (typeof window.$uid !== 'undefined') return window.$uid;
        if (typeof window.$myuid !== 'undefined') return window.$myuid;
        return null;
    }

    async function fetchBonusData(uid) {
        const response = await fetch("https://potok.cash/member/getmemberdeposits", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ uid: uid, active: 1 }),
            credentials: "include"
        });
        const data = await response.json();
        if (data && data.date_next && data.date) {
            return {
                next: data.date_next * 1000,
                serverNow: data.date * 1000,
                delayMs: (data.date_next - data.date) * 1000
            };
        }
        throw new Error("Не удалось получить date_next/date");
    }

    async function sendBonusRequest() {
        const response = await fetch("https://potok.cash/site/SetUserDepositBonus", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ program: PROGRAM }),   // ← динамическая подстановка
            credentials: "include"
        });
        const data = await response.json();
        console.log(`📨 [${PROGRAM}] Ответ сервера:`, data);
        channel.postMessage({ type: 'BONUS_SENT', time: Date.now(), tabId });
        return data;
    }

    function finishCycle() {
        console.log(`✅ [${PROGRAM}] Обнаружен 'status' – перезагрузка`);
        location.reload();
    }

    function scheduleRetry() {
        if (retryTimer) clearTimeout(retryTimer);
        console.log(`🔄 [${PROGRAM}] Ключ 'status' отсутствует – повторный запрос через 60 секунд...`);
        retryTimer = setTimeout(async () => {
            try {
                const data = await sendBonusRequest();
                handleBonusResponse(data);
            } catch (error) {
                console.error(`❌ [${PROGRAM}] Ошибка повтора:`, error);
                scheduleRetry();
            }
        }, 60000);
    }

    function handleBonusResponse(data) {
        if (data && data.hasOwnProperty('status')) {
            finishCycle();
        } else {
            scheduleRetry();
        }
    }

    async function leaderLoop() {
        if (!isLeader) return;
        try {
            const uid = getUid();
            if (!uid) {
                console.warn(`⚠️ [${PROGRAM}] UID не найден, повтор через 60 сек`);
                setTimeout(leaderLoop, 60000);
                return;
            }
            const { next, serverNow } = await fetchBonusData(uid);
            const delayBase = next - serverNow;
            const randomExtra = 60000 + Math.random() * 60000;
            let totalDelay = delayBase > 0 ? delayBase + randomExtra : randomExtra;
            console.log(`⏳ [${PROGRAM}] Задержка: ${Math.round(totalDelay/1000)} сек`);
            currentTimer = setTimeout(async () => {
                try {
                    const data = await sendBonusRequest();
                    handleBonusResponse(data);
                } catch (error) {
                    console.error(`❌ [${PROGRAM}] Ошибка отправки:`, error);
                    scheduleRetry();
                }
            }, totalDelay);
        } catch (error) {
            console.error(`❌ [${PROGRAM}] Ошибка leaderLoop:`, error);
            finishCycle();
        }
    }

    function startHeartbeat() {
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        heartbeatInterval = setInterval(() => {
            if (isLeader) {
                channel.postMessage({ type: 'HEARTBEAT', time: Date.now(), tabId });
            }
        }, 5000);
    }

    function becomeLeader() {
        if (isLeader) return;
        isLeader = true;
        recognizedLeaderId = tabId;
        myLeaderTime = Date.now();
        console.log(`👑 [${PROGRAM}] Вкладка ${tabId} стала лидером`);
        channel.postMessage({ type: 'NEW_LEADER', time: Date.now(), tabId });
        startHeartbeat();
        leaderLoop();
    }

    function resignLeadership() {
        if (isLeader) {
            console.log(`👋 [${PROGRAM}] Вкладка ${tabId} передаёт лидерство`);
            isLeader = false;
            recognizedLeaderId = null;
            if (currentTimer) { clearTimeout(currentTimer); currentTimer = null; }
            if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
            if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
        }
    }

    function electLeader() {
        const randomDelay = Math.random() * 3000;
        setTimeout(() => {
            console.log(`🔍 [${PROGRAM}] Поиск лидера...`);
            channel.postMessage({ type: 'LEADER_CHECK', time: Date.now(), tabId });
            const checkTimeout = setTimeout(() => {
                console.log(`⏳ [${PROGRAM}] Лидер не ответил – становимся лидером`);
                becomeLeader();
            }, 2000);
            const responseHandler = (event) => {
                if (event.data.type === 'LEADER_ALIVE') {
                    clearTimeout(checkTimeout);
                    channel.removeEventListener('message', responseHandler);
                    recognizedLeaderId = event.data.tabId;
                    lastHeartbeat = Date.now();
                }
            };
            channel.addEventListener('message', responseHandler);
        }, randomDelay);
    }

    channel.onmessage = (event) => {
        const msg = event.data;
        if (msg.type === 'HEARTBEAT') {
            if (!isLeader) {
                if (recognizedLeaderId === null || recognizedLeaderId === msg.tabId) {
                    recognizedLeaderId = msg.tabId;
                    lastHeartbeat = msg.time;
                } else {
                    console.log(`🔄 [${PROGRAM}] Смена лидера: ${recognizedLeaderId} -> ${msg.tabId}`);
                    recognizedLeaderId = msg.tabId;
                    lastHeartbeat = msg.time;
                }
            }
            return;
        }
        if (msg.type === 'NEW_LEADER') {
            if (isLeader) {
                if (msg.time > myLeaderTime || (msg.time === myLeaderTime && msg.tabId < tabId)) {
                    resignLeadership();
                }
            } else {
                recognizedLeaderId = msg.tabId;
                lastHeartbeat = Date.now();
            }
            return;
        }
        if (msg.type === 'BONUS_SENT') {
            if (isLeader) {
                console.log(`📻 [${PROGRAM}] Бонус уже отправлен, перепланируем`);
                if (currentTimer) clearTimeout(currentTimer);
                leaderLoop();
            }
            return;
        }
        if (msg.type === 'LEADER_CHECK') {
            if (isLeader) channel.postMessage({ type: 'LEADER_ALIVE', time: Date.now(), tabId });
            return;
        }
    };

    setInterval(() => {
        if (!isLeader && recognizedLeaderId && Date.now() - lastHeartbeat > 30000) {
            console.log(`💔 [${PROGRAM}] Лидер ${recognizedLeaderId} пропал, перевыборы`);
            recognizedLeaderId = null;
            electLeader();
        }
    }, 15000);

    function initialize() {
        console.log(`🚀 [${PROGRAM}] Скрипт запущен`);
        myLeaderTime = Date.now();
        electLeader();
        window.addEventListener('beforeunload', () => {
            if (isLeader) channel.postMessage({ type: 'NEW_LEADER', time: Date.now(), tabId });
        });
    }

    if (document.readyState === 'complete') initialize();
    else window.addEventListener('load', initialize);
})();
