// ==UserScript==
// @name         Potok Cash Bonus Keeper
// @namespace    https://potok.cash/cabinet
// @version      20260406131910
// @description  Automation for pressing bonus button each 24 hours
// @author       You
// @match        https://potok.cash/cabinet
// @icon         https://www.google.com/s2/favicons?sz=64&domain=potok.cash
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // --- Уникальный идентификатор текущей вкладки ---
    const tabId = Math.random().toString(36).substring(2) + Date.now().toString(36);
    console.log(`🆔 Вкладка инициализирована, ID: ${tabId}`);

    // --- Канал связи ---
    const channel = new BroadcastChannel('potok-bonus-channel');

    // --- Состояние ---
    let isLeader = false;
    let currentTimer = null;
    let retryTimer = null;
    let heartbeatInterval = null;
    let lastHeartbeat = Date.now();
    let recognizedLeaderId = null;

    // --- Получение uid ---
    function getUid() {
        if (typeof window.$uid !== 'undefined') return window.$uid;
        if (typeof window.$myuid !== 'undefined') return window.$myuid;
        return null;
    }

    // --- Получение данных с сервера ---
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

    // --- Отправка бонуса ---
    async function sendBonusRequest() {
        const response = await fetch("https://potok.cash/site/SetUserDepositBonus", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ program: "growing" }),
            credentials: "include"
        });
        const data = await response.json();
        console.log("📨 Ответ сервера на отправку бонуса:", data);
        channel.postMessage({ type: 'BONUS_SENT', time: Date.now(), tabId });
        return data;
    }

    // --- Завершение цикла: перезагрузка БЕЗ задержки (при наличии status) ---
    function finishCycle() {
        console.log("✅ Обнаружен ключ 'status' – перезагрузка страницы немедленно...");
        location.reload();
    }

    // --- Повторная попытка (если нет status) – задержка 60 секунд ---
    function scheduleRetry() {
        if (retryTimer) clearTimeout(retryTimer);
        console.log("🔄 Ключ 'status' отсутствует – повторный запрос через 60 секунд...");
        retryTimer = setTimeout(async () => {
            try {
                const data = await sendBonusRequest();
                handleBonusResponse(data);
            } catch (error) {
                console.error("❌ Ошибка при повторном запросе бонуса:", error);
                scheduleRetry();   // ошибка сети – тоже повторяем через 60 секунд
            }
        }, 60000);
    }

    // --- Обработка ответа: есть status → перезагрузка, иначе → повтор через 60 секунд ---
    function handleBonusResponse(data) {
        if (data && data.hasOwnProperty('status')) {
            finishCycle();
        } else {
            scheduleRetry();
        }
    }

    // --- Основной цикл лидера ---
    async function leaderLoop() {
        if (!isLeader) return;

        try {
            const uid = getUid();
            if (!uid) {
                console.warn("⚠️ UID не найден, повтор через 60 сек");
                setTimeout(leaderLoop, 60000);
                return;
            }

            const { next, serverNow } = await fetchBonusData(uid);
            const delayBase = next - serverNow;
            const randomExtra = 60000 + Math.random() * 60000;
            let totalDelay;
            if (delayBase > 0) {
                totalDelay = delayBase + randomExtra;
                console.log(`⏳ Базовая задержка до date_next: ${Math.round(delayBase/1000)} сек, случайная добавка: ${Math.round(randomExtra/1000)} сек, всего: ${Math.round(totalDelay/1000)} сек`);
            } else {
                totalDelay = randomExtra;
                console.log(`⏳ Время date_next уже наступило, отправка через случайные ${Math.round(randomExtra/1000)} сек`);
            }

            currentTimer = setTimeout(async () => {
                try {
                    const data = await sendBonusRequest();
                    handleBonusResponse(data);
                } catch (error) {
                    console.error("❌ Ошибка при отправке бонуса:", error);
                    scheduleRetry();
                }
            }, totalDelay);

        } catch (error) {
            console.error("❌ Ошибка в leaderLoop:", error);
            finishCycle();   // критическая ошибка – перезагрузка немедленно
        }
    }

    // --- Heartbeat отправка (только лидер) ---
    function startHeartbeat() {
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        heartbeatInterval = setInterval(() => {
            if (isLeader) {
                console.log(`💓 Отправка heartbeat от лидера ${tabId}`);
                channel.postMessage({ type: 'HEARTBEAT', time: Date.now(), tabId });
            }
        }, 5000);
    }

    // --- Стать лидером ---
    function becomeLeader() {
        if (isLeader) return;
        isLeader = true;
        recognizedLeaderId = tabId;
        console.log(`👑 Вкладка ${tabId} стала главной`);
        channel.postMessage({ type: 'NEW_LEADER', time: Date.now(), tabId });
        startHeartbeat();
        leaderLoop();
    }

    // --- Отказаться от лидерства ---
    function resignLeadership() {
        if (isLeader) {
            console.log(`👋 Вкладка ${tabId} передаёт лидерство`);
            isLeader = false;
            recognizedLeaderId = null;
            if (currentTimer) {
                clearTimeout(currentTimer);
                currentTimer = null;
            }
            if (retryTimer) {
                clearTimeout(retryTimer);
                retryTimer = null;
            }
            if (heartbeatInterval) {
                clearInterval(heartbeatInterval);
                heartbeatInterval = null;
            }
        }
    }

    // --- Выборы лидера ---
    function electLeader() {
        const randomDelay = Math.random() * 3000;
        setTimeout(() => {
            console.log(`🔍 Вкладка ${tabId} ищет лидера...`);
            channel.postMessage({ type: 'LEADER_CHECK', time: Date.now(), tabId });

            const checkTimeout = setTimeout(() => {
                console.log(`⏳ Таймаут, никто не ответил – становимся лидером`);
                becomeLeader();
            }, 2000);

            const responseHandler = (event) => {
                if (event.data.type === 'LEADER_ALIVE') {
                    clearTimeout(checkTimeout);
                    channel.removeEventListener('message', responseHandler);
                    recognizedLeaderId = event.data.tabId;
                    lastHeartbeat = Date.now();
                    console.log(`📻 Получен ответ от лидера ${recognizedLeaderId}, остаёмся в режиме ожидания`);
                }
            };
            channel.addEventListener('message', responseHandler);
        }, randomDelay);
    }

    // --- Обработка входящих сообщений ---
    channel.onmessage = (event) => {
        const msg = event.data;

        if (msg.type === 'HEARTBEAT') {
            if (!isLeader) {
                console.log(`💗 Получен heartbeat от лидера ${msg.tabId}`);
                if (recognizedLeaderId === null) {
                    recognizedLeaderId = msg.tabId;
                    lastHeartbeat = msg.time;
                } else if (recognizedLeaderId === msg.tabId) {
                    lastHeartbeat = msg.time;
                } else {
                    console.log(`🔄 Смена лидера: ${recognizedLeaderId} -> ${msg.tabId}`);
                    recognizedLeaderId = msg.tabId;
                    lastHeartbeat = msg.time;
                }
            }
            return;
        }

        if (msg.type === 'NEW_LEADER') {
            if (isLeader) {
                if (msg.time > (window._myLeaderTime || 0)) {
                    console.log(`⚔️ Конфликт: новый лидер ${msg.tabId} объявился позже, уступаем`);
                    resignLeadership();
                } else if (msg.time === (window._myLeaderTime || 0) && msg.tabId < tabId) {
                    console.log(`⚔️ Конфликт: одинаковое время, но ID ${msg.tabId} меньше, уступаем`);
                    resignLeadership();
                } else {
                    console.log(`⚔️ Конфликт: остаёмся лидером`);
                }
            } else {
                recognizedLeaderId = msg.tabId;
                lastHeartbeat = Date.now();
                console.log(`📢 Новый лидер объявлен: ${recognizedLeaderId}`);
            }
            return;
        }

        if (msg.type === 'BONUS_SENT') {
            if (isLeader) {
                console.log('📻 Бонус уже отправлен в другой вкладке, перепланируем');
                if (currentTimer) clearTimeout(currentTimer);
                leaderLoop();
            }
            return;
        }

        if (msg.type === 'LEADER_CHECK') {
            if (isLeader) {
                console.log(`📡 Ответ на проверку лидерства от ${msg.tabId}`);
                channel.postMessage({ type: 'LEADER_ALIVE', time: Date.now(), tabId });
            }
            return;
        }

        if (msg.type === 'LEADER_ALIVE') {
            console.log(`📨 Получен LEADER_ALIVE от ${msg.tabId} (вне выборов)`);
            return;
        }
    };

    // --- Мониторинг здоровья лидера (для не-лидеров) ---
    setInterval(() => {
        if (!isLeader && recognizedLeaderId !== null) {
            const timeSinceLastHeartbeat = Date.now() - lastHeartbeat;
            if (timeSinceLastHeartbeat > 30000) {
                console.log(`💔 Сердцебиение лидера ${recognizedLeaderId} пропало (прошло ${Math.round(timeSinceLastHeartbeat/1000)} сек), запускаем выборы`);
                recognizedLeaderId = null;
                electLeader();
            }
        }
    }, 15000);

    // --- Инициализация после полной загрузки ---
    function initialize() {
        console.log(`🚀 Скрипт запущен во вкладке ${tabId}`);
        window._myLeaderTime = Date.now();
        electLeader();

        window.addEventListener('beforeunload', () => {
            if (isLeader) {
                channel.postMessage({ type: 'NEW_LEADER', time: Date.now(), tabId });
            }
        });
    }

    if (document.readyState === 'complete') {
        initialize();
    } else {
        window.addEventListener('load', initialize);
    }
})();
