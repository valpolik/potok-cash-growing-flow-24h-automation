// ==UserScript==
// @name         Potok Deposit Bonus Keeper (heartbeat + логи)
// @namespace    https://potok.cash/cabinet
// @version      8.0
// @description  Точное время бонуса с координацией вкладок через heartbeat
// @author       You
// @match        https://potok.cash/cabinet
// @icon         https://www.google.com/s2/favicons?sz=64&domain=potok.cash
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // --- Константы ---
    const HEARTBEAT_INTERVAL = 5000;        // лидер шлёт heartbeat каждые 5 сек
    const LEADER_TIMEOUT = 30000;           // если 30 сек нет heartbeat, считаем лидера мёртвым
    const ELECTION_DELAY = 2000;             // задержка перед выборами, чтобы избежать одновременных
    const LEADER_CHECK_TIMEOUT = 2000;       // сколько ждать ответа на LEADER_CHECK

    // --- Глобальные переменные вкладки ---
    const tabId = Math.random().toString(36).substring(2) + Date.now(); // уникальный ID вкладки
    let isLeader = false;
    let currentTimer = null;                  // таймер бонуса
    let heartbeatInterval = null;              // интервал отправки heartbeat (если лидер)
    let heartbeatWatchdog = null;              // таймер, следящий за heartbeat (если не лидер)
    let lastHeartbeatTime = 0;                 // время последнего heartbeat от лидера

    // --- Канал связи ---
    const channel = new BroadcastChannel('potok-bonus-channel');

    // --- Логирование с префиксом вкладки ---
    function log(level, message, ...args) {
        const prefix = `[Tab ${tabId.slice(0,4)}]`;
        const fullMsg = `${prefix} ${message}`;
        switch(level) {
            case 'info': console.log(fullMsg, ...args); break;
            case 'warn': console.warn(fullMsg, ...args); break;
            case 'error': console.error(fullMsg, ...args); break;
            default: console.log(fullMsg, ...args);
        }
    }

    // --- Получение uid из глобальных переменных ---
    function getUid() {
        if (typeof window.$uid !== 'undefined') return window.$uid;
        if (typeof window.$myuid !== 'undefined') return window.$myuid;
        return null;
    }

    // --- Запрос данных с сервера ---
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
        log('info', "Отправка бонусного запроса...");
        const response = await fetch("https://potok.cash/site/SetUserDepositBonus", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ program: "growing" }),
            credentials: "include"
        });
        const data = await response.json();
        log('info', "✅ Бонус отправлен, ответ:", data);
        channel.postMessage({ type: 'BONUS_SENT', tabId, time: Date.now() });
        return data;
    }

    // --- Основной цикл лидера ---
    async function leaderLoop() {
        if (!isLeader) return;

        try {
            const uid = getUid();
            if (!uid) {
                log('warn', "UID не найден, повтор через 60 сек");
                currentTimer = setTimeout(leaderLoop, 60000);
                return;
            }

            const { delayMs } = await fetchBonusData(uid);

            if (delayMs > 0) {
                log('info', `⏳ Точная задержка по серверу: ${Math.round(delayMs/1000)} сек (${new Date(Date.now() + delayMs).toLocaleTimeString()})`);
                currentTimer = setTimeout(async () => {
                    try {
                        await sendBonusRequest();
                        leaderLoop(); // следующий цикл
                    } catch (e) {
                        log('error', "Ошибка отправки бонуса:", e);
                        currentTimer = setTimeout(leaderLoop, 60000);
                    }
                }, delayMs);
            } else {
                log('warn', "⚠️ Время бонуса уже наступило, отправляем сейчас");
                await sendBonusRequest();
                leaderLoop();
            }
        } catch (error) {
            log('error', "Ошибка в цикле лидера:", error);
            currentTimer = setTimeout(leaderLoop, 60000);
        }
    }

    // --- Запуск heartbeat (если лидер) ---
    function startHeartbeat() {
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        heartbeatInterval = setInterval(() => {
            if (isLeader) {
                channel.postMessage({ type: 'LEADER_HEARTBEAT', tabId, time: Date.now() });
                log('info', "💓 Heartbeat отправлен");
            } else {
                // Если перестали быть лидером, остановим heartbeat
                clearInterval(heartbeatInterval);
                heartbeatInterval = null;
            }
        }, HEARTBEAT_INTERVAL);
    }

    // --- Остановка heartbeat ---
    function stopHeartbeat() {
        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
            heartbeatInterval = null;
        }
    }

    // --- Запуск watchdog (слежка за лидером) ---
    function startWatchdog() {
        if (heartbeatWatchdog) clearTimeout(heartbeatWatchdog);
        heartbeatWatchdog = setTimeout(() => {
            if (!isLeader) {
                log('warn', "💔 Heartbeat от лидера пропал, инициируем выборы");
                electLeader(); // запускаем процедуру выборов
            }
        }, LEADER_TIMEOUT);
    }

    // --- Сброс watchdog ---
    function resetWatchdog() {
        if (!isLeader) {
            if (heartbeatWatchdog) clearTimeout(heartbeatWatchdog);
            startWatchdog();
        }
    }

    // --- Становимся лидером ---
    function becomeLeader() {
        if (isLeader) return;
        isLeader = true;
        log('info', "👑 Эта вкладка стала главной (ID: " + tabId + ")");
        channel.postMessage({ type: 'NEW_LEADER', tabId, time: Date.now() });

        // Останавливаем watchdog (мы теперь лидер, следить не надо)
        if (heartbeatWatchdog) clearTimeout(heartbeatWatchdog);

        // Запускаем heartbeat
        startHeartbeat();

        // Запускаем цикл бонуса
        leaderLoop();
    }

    // --- Отказ от лидерства ---
    function resignLeadership() {
        if (isLeader) {
            log('info', "👋 Передача лидерства другой вкладке");
            isLeader = false;
            stopHeartbeat();
            if (currentTimer) {
                clearTimeout(currentTimer);
                currentTimer = null;
            }
            // Запускаем watchdog, чтобы следить за новым лидером
            lastHeartbeatTime = 0;
            startWatchdog();
        }
    }

    // --- Выборы лидера (если нет heartbeat или при старте) ---
    function electLeader() {
        log('info', "Начинаем выборы нового лидера...");

        // Случайная задержка, чтобы избежать одновременных выборов
        const delay = Math.random() * ELECTION_DELAY;
        setTimeout(() => {
            // Перед тем как стать лидером, проверим, не появился ли уже лидер
            // Отправляем запрос LEADER_CHECK
            channel.postMessage({ type: 'LEADER_CHECK', tabId, time: Date.now() });

            const checkTimeout = setTimeout(() => {
                // Никто не ответил — становимся лидером
                becomeLeader();
            }, LEADER_CHECK_TIMEOUT);

            const responseHandler = (event) => {
                const msg = event.data;
                if (msg.type === 'LEADER_ALIVE') {
                    // Есть лидер, отменяем попытку
                    clearTimeout(checkTimeout);
                    channel.removeEventListener('message', responseHandler);
                    log('info', `Лидер уже есть (${msg.tabId}), остаёмся в режиме ожидания`);
                    // Обновим lastHeartbeatTime, чтобы watchdog не сработал раньше времени
                    lastHeartbeatTime = msg.time;
                    resetWatchdog();
                }
            };
            channel.addEventListener('message', responseHandler);
        }, delay);
    }

    // --- Обработка входящих сообщений ---
    channel.onmessage = (event) => {
        const msg = event.data;

        switch (msg.type) {
            case 'LEADER_HEARTBEAT':
                // Получен heartbeat от лидера
                lastHeartbeatTime = msg.time;
                if (!isLeader) {
                    log('info', `💓 Heartbeat от лидера ${msg.tabId.slice(0,4)}`);
                    resetWatchdog(); // сбрасываем таймер отсутствия heartbeat
                }
                break;

            case 'NEW_LEADER':
                // Кто-то объявил себя лидером
                if (!isLeader) {
                    log('info', `Новый лидер объявлен: ${msg.tabId.slice(0,4)}`);
                    lastHeartbeatTime = msg.time;
                    resetWatchdog();
                } else {
                    // Конфликт: мы тоже лидер. Сравниваем ID и время.
                    if (msg.tabId !== tabId) {
                        log('warn', `Конфликт лидеров: наш ${tabId.slice(0,4)} против ${msg.tabId.slice(0,4)}`);
                        // Уступаем, если чужой ID меньше (или по времени объявления)
                        if (msg.tabId < tabId) {
                            log('info', "Уступаем лидерство (чужой ID меньше)");
                            resignLeadership();
                            lastHeartbeatTime = msg.time;
                            resetWatchdog();
                        } else {
                            log('info', "Остаёмся лидером (наш ID меньше)");
                            // Отправляем свой heartbeat, чтобы перебить
                            channel.postMessage({ type: 'LEADER_HEARTBEAT', tabId, time: Date.now() });
                        }
                    }
                }
                break;

            case 'LEADER_CHECK':
                // Запрос от другой вкладки: есть ли лидер?
                if (isLeader) {
                    channel.postMessage({ type: 'LEADER_ALIVE', tabId, time: Date.now() });
                }
                break;

            case 'LEADER_ALIVE':
                // Ответ на LEADER_CHECK — обрабатывается выше в electLeader
                break;

            case 'BONUS_SENT':
                if (isLeader && msg.tabId !== tabId) {
                    log('info', 'Бонус отправлен в другой вкладке, перепланируем');
                    if (currentTimer) clearTimeout(currentTimer);
                    leaderLoop(); // запросим новый date_next
                }
                break;
        }
    };

    // --- Инициализация после загрузки страницы ---
    function initialize() {
        log('info', "🚀 Скрипт запущен, ID вкладки:", tabId);

        // Сразу запускаем watchdog (будем ждать heartbeat)
        lastHeartbeatTime = 0;
        startWatchdog();

        // Инициируем выборы, чтобы проверить, есть ли лидер
        electLeader();

        // При закрытии вкладки-лидера оповещаем
        window.addEventListener('beforeunload', () => {
            if (isLeader) {
                log('info', "Вкладка закрывается, оповещаем остальных");
                channel.postMessage({ type: 'NEW_LEADER', tabId, time: Date.now() });
                stopHeartbeat();
            }
        });
    }

    // Ждём полной загрузки страницы
    if (document.readyState === 'complete') {
        initialize();
    } else {
        window.addEventListener('load', initialize);
    }
})();
