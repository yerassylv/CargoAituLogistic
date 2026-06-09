let allNotifications = [];

let currentTab = "all";

function notificationsApiBase() {
    const b = typeof API_URL !== "undefined" && API_URL ? String(API_URL).replace(/\/$/, "") : "https://cargoplatform.onrender.com";
    return `${b}/api`;
}

function getHeaders() {
    const userData = localStorage.getItem("user");
    if (!userData) {
        throw new Error("Пользователь не авторизован");
    }
    const user = JSON.parse(userData);
    if (!user || !user.id) {
        throw new Error("Пользователь не авторизован");
    }
    return {
        "Content-Type": "application/json",
        "X-User-Id": user.id.toString()
    };
}

const BID_TYPES = new Set([ "new_bid", "bid_updated", "bid_won", "carrier_accepted", "carrier_declined" ]);

const DOC_TYPES = new Set([ "contract_created", "contract_approved", "contract_rejected", "contract_document_uploaded", "contract_signed" ]);

function notificationNeedsAction(n) {
    if (n.type === "completion_requested") return true;
    if (n.type === "contract_created") return true;
    if (n.type === "contract_rejected") return true;
    if (n.type === "contract_signed" && /требуется\s+ваша\s+подпись|требуется\s+подпись/i.test(n.message || "")) {
        return true;
    }
    return false;
}

function matchesTab(n, tab) {
    if (tab === "all") return true;
    if (tab === "action") return notificationNeedsAction(n);
    if (tab === "bids") return BID_TYPES.has(n.type);
    if (tab === "documents") return DOC_TYPES.has(n.type);
    return true;
}

function parseRouteFromMessage(msg) {
    if (!msg) return null;
    const mRoute = msg.match(/(?:заявки|заявку)\s*:\s*([^→\n]+)\s*→\s*([^\n.]+)/i);
    if (mRoute) {
        const from = mRoute[1].trim();
        const to = mRoute[2].trim().replace(/\.$/, "").trim();
        if (from.length >= 2 && to.length >= 2) return {
            from: from,
            to: to
        };
    }
    const loose = msg.match(/([^→\n]+)\s*→\s*([^\n.]+)/);
    if (loose) {
        const from = loose[1].trim();
        const to = loose[2].trim().replace(/\.$/, "").trim();
        if (/перевозчик|запросил|заявк|ставк|получена/i.test(from)) {
            return null;
        }
        if (from.length >= 2 && to.length >= 2) return {
            from: from,
            to: to
        };
    }
    return null;
}

function parsePriceFromMessage(msg) {
    if (!msg) return null;
    const m = msg.match(/([\d\s\u00a0]+)\s*₸/);
    if (!m) return null;
    const num = m[1].replace(/\s/g, " ").trim();
    return `${num} ₸`;
}

function humanizeName(s) {
    if (!s || typeof s !== "string") return "";
    const t = s.trim();
    if (!t) return "";
    return t.split(/\s+/).map(word => {
        if (word.length <= 1) return word;
        const letters = word.replace(/[^A-Za-zА-Яа-яЁё]/g, "");
        if (letters.length > 1 && letters === letters.toUpperCase()) {
            return word.charAt(0) + word.slice(1).toLowerCase();
        }
        return word;
    }).join(" ");
}

function parseActorFromMessage(msg) {
    if (!msg) return null;
    let m = msg.match(/Перевозчик\s+(.+?)\s+запросил/i);
    if (m) {
        return {
            role: "Перевозчик",
            name: humanizeName(m[1].trim())
        };
    }
    m = msg.match(/Перевозчик\s+(.+?)(?:\.|,|\s+Цена|\s+получена)/i);
    if (m) {
        return {
            role: "Перевозчик",
            name: humanizeName(m[1].trim())
        };
    }
    m = msg.match(/Заказчик\s+(.+?)\s+подтвердил/i);
    if (m) {
        return {
            role: "Заказчик",
            name: humanizeName(m[1].trim())
        };
    }
    return null;
}

function getVisualKind(type) {
    if (type === "completion_requested") return "action";
    if (type === "request_completed") return "done";
    if (BID_TYPES.has(type)) return "bid";
    if (DOC_TYPES.has(type)) return "doc";
    return "info";
}

function iconSvg(kind) {
    const common = 'width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"';
    switch (kind) {
      case "action":
        return `<svg ${common} aria-hidden="true"><path d="M12 9v4m0 4h.01M10.3 3.2L2.8 18c-.5 1 .2 2 1.3 2h16.8c1.1 0 1.8-1 1.3-2L13.7 3.2c-.5-1-1.8-1-2.4 0z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

      case "bid":
        return `<svg ${common} aria-hidden="true"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

      case "doc":
        return `<svg ${common} aria-hidden="true"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;

      case "done":
        return `<svg ${common} aria-hidden="true"><path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

      default:
        return `<svg ${common} aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.5"/><path d="M12 8v4l3 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
    }
}

function buildMetaLines(n) {
    const msg = n.message || "";
    const route = parseRouteFromMessage(msg);
    const price = parsePriceFromMessage(msg);
    const actor = parseActorFromMessage(msg);
    const parts = [];
    if (route) {
        parts.push(`<span class="nc-meta-item nc-meta-route">${escapeHtml(route.from)} → ${escapeHtml(route.to)}</span>`);
    }
    if (actor) {
        parts.push(`<span class="nc-meta-item"><span class="nc-meta-k">${escapeHtml(actor.role)}:</span> ${escapeHtml(actor.name)}</span>`);
    }
    if (price) {
        parts.push(`<span class="nc-meta-item nc-meta-price">${escapeHtml(price)}</span>`);
    }
    return parts.join("");
}

function cardActionsHtml(n) {
    const rid = n.request_id;
    if (!rid) return "";
    if (n.type === "completion_requested") {
        return `\n      <div class="nc-card-actions">\n        <button type="button" class="nc-btn nc-btn--primary" data-nc-confirm-completion="${rid}" data-notification-id="${n.id}">Подтвердить</button>\n        <button type="button" class="nc-btn nc-btn--secondary" data-nc-open="${rid}" data-notification-id="${n.id}">Открыть заявку</button>\n      </div>`;
    }
    if (notificationNeedsAction(n)) {
        return `\n      <div class="nc-card-actions">\n        <button type="button" class="nc-btn nc-btn--primary" data-nc-open="${rid}" data-notification-id="${n.id}">Открыть заявку</button>\n      </div>`;
    }
    return "";
}

function getSkeletonHtml() {
    const rows = [ 1, 2, 3, 4 ].map(() => `\n    <div class="nc-skeleton-row" aria-hidden="true">\n      <div class="nc-skeleton-icon"></div>\n      <div class="nc-skeleton-lines">\n        <div class="nc-skeleton-line nc-skeleton-line--lg"></div>\n        <div class="nc-skeleton-line"></div>\n        <div class="nc-skeleton-line nc-skeleton-line--sm"></div>\n      </div>\n    </div>`);
    return `<div class="nc-skeleton" aria-busy="true" aria-label="Загрузка">${rows.join("")}</div>`;
}

function startOfLocalDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function groupByRelativeDay(items) {
    const now = new Date;
    const today0 = startOfLocalDay(now).getTime();
    const y0 = today0 - 864e5;
    const groups = {
        today: [],
        yesterday: [],
        older: []
    };
    items.forEach(n => {
        const t = new Date(n.created_at).getTime();
        if (t >= today0) groups.today.push(n); else if (t >= y0) groups.yesterday.push(n); else groups.older.push(n);
    });
    return groups;
}

function formatCardTime(iso) {
    const d = new Date(iso);
    return d.toLocaleString("ru-RU", {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit"
    });
}

async function loadNotifications() {
    const messagesList = document.getElementById("messagesList");
    if (!messagesList) {
        return;
    }
    messagesList.innerHTML = getSkeletonHtml();
    try {
        const headers = getHeaders();
        const response = await fetch(`${notificationsApiBase()}/notifications`, {
            headers: headers
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Ошибка загрузки: ${response.status} ${errorText}`);
        }
        const notifications = await response.json();
        allNotifications = notifications;
        applyFilters();
        updateUnreadBadge();
    } catch (error) {
        console.error("Ошибка загрузки уведомлений:", error);
        messagesList.innerHTML = `<div class="nc-empty nc-empty--error"><p>${escapeHtml(error.message)}</p></div>`;
    }
}

function applyFilters() {
    const searchInput = document.getElementById("messagesSearchInput");
    const term = searchInput && searchInput.value.toLowerCase().trim() || "";
    let list = allNotifications.filter(n => matchesTab(n, currentTab));
    if (term) {
        list = list.filter(n => {
            const title = (n.title || "").toLowerCase();
            const message = (n.message || "").toLowerCase();
            return title.includes(term) || message.includes(term);
        });
    }
    displayNotifications(list);
}

function displayNotifications(notifications) {
    const messagesList = document.getElementById("messagesList");
    if (!messagesList) {
        return;
    }
    if (!notifications || notifications.length === 0) {
        const labels = {
            all: "Нет уведомлений",
            action: "Нет событий, требующих действия",
            bids: "Нет уведомлений по ставкам",
            documents: "Нет уведомлений по документам"
        };
        messagesList.innerHTML = `<div class="nc-empty"><p>${labels[currentTab] || labels.all}</p></div>`;
        return;
    }
    const sorted = [ ...notifications ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const g = groupByRelativeDay(sorted);
    const sections = [];
    if (g.today.length) {
        sections.push(`<section class="nc-group"><h2 class="nc-group-label">Сегодня</h2><div class="nc-group-cards">${g.today.map(renderNotificationCard).join("")}</div></section>`);
    }
    if (g.yesterday.length) {
        sections.push(`<section class="nc-group"><h2 class="nc-group-label">Вчера</h2><div class="nc-group-cards">${g.yesterday.map(renderNotificationCard).join("")}</div></section>`);
    }
    if (g.older.length) {
        sections.push(`<section class="nc-group"><h2 class="nc-group-label">Ранее</h2><div class="nc-group-cards">${g.older.map(renderNotificationCard).join("")}</div></section>`);
    }
    messagesList.innerHTML = sections.join("");
    bindNotificationCardEvents(messagesList);
}

function renderNotificationCard(n) {
    const read = n.is_read;
    const kind = getVisualKind(n.type);
    const needs = notificationNeedsAction(n);
    const highlight = needs && !read;
    let mod = `nc-card--kind-${kind}`;
    if (read) mod += " nc-card--read";
    if (highlight) mod += " nc-card--actionable";
    const metaHtml = buildMetaLines(n);
    const requestId = n.request_id || "";
    const timeStr = formatCardTime(n.created_at);
    const titleClass = read ? "nc-card-title" : "nc-card-title nc-card-title--unread";
    return `\n    <article class="nc-card ${mod}" data-notification-id="${n.id}" data-request-id="${requestId}">\n      <button type="button" class="nc-dismiss" title="Скрыть" aria-label="Удалить уведомление" data-nc-dismiss="${n.id}">\n        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M12 4L4 12M4 4l8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>\n      </button>\n      <div class="nc-card-hit" data-nc-card-hit="1">\n        <div class="nc-icon-wrap nc-icon-wrap--${kind}" aria-hidden="true">${iconSvg(kind)}</div>\n        <div class="nc-card-body">\n          <div class="nc-title-row">\n            ${read ? "" : '<span class="nc-unread-dot" aria-hidden="true"></span>'}\n            <h2 class="${titleClass}">${escapeHtml(n.title)}</h2>\n          </div>\n          ${metaHtml ? `<div class="nc-meta">${metaHtml}</div>` : ""}\n          <time class="nc-time" datetime="${n.created_at}">${timeStr}</time>\n        </div>\n      </div>\n      ${cardActionsHtml(n)}\n    </article>\n  `;
}

function bindNotificationCardEvents(container) {
    container.querySelectorAll("[data-nc-card-hit]").forEach(el => {
        el.addEventListener("click", () => {
            const card = el.closest(".nc-card");
            if (!card) return;
            const id = parseInt(card.dataset.notificationId, 10);
            const rid = card.dataset.requestId ? parseInt(card.dataset.requestId, 10) : null;
            openNotification(id, rid);
        });
    });
    container.querySelectorAll("[data-nc-open]").forEach(btn => {
        btn.addEventListener("click", e => {
            e.stopPropagation();
            const nid = parseInt(btn.getAttribute("data-notification-id"), 10);
            const rid = parseInt(btn.getAttribute("data-nc-open"), 10);
            openNotification(nid, rid);
        });
    });
    container.querySelectorAll("[data-nc-confirm-completion]").forEach(btn => {
        btn.addEventListener("click", e => {
            e.stopPropagation();
            const rid = parseInt(btn.getAttribute("data-nc-confirm-completion"), 10);
            const nid = parseInt(btn.getAttribute("data-notification-id"), 10);
            confirmCompletionFromNotification(rid, nid);
        });
    });
    container.querySelectorAll("[data-nc-dismiss]").forEach(btn => {
        btn.addEventListener("click", e => {
            e.stopPropagation();
            const id = parseInt(btn.getAttribute("data-nc-dismiss"), 10);
            dismissNotification(id);
        });
    });
}

async function openNotification(notificationId, requestId) {
    try {
        const headers = getHeaders();
        const response = await fetch(`${notificationsApiBase()}/notifications/${notificationId}/read`, {
            method: "POST",
            headers: headers
        });
        if (!response.ok) {
            throw new Error("Не удалось отметить прочитанным");
        }
        await loadNotifications();
        updateUnreadBadge();
        if (requestId && !Number.isNaN(requestId)) {
            if (window.location.pathname.includes("messages.html")) {
                if (typeof navigateWithTransition === "function") {
                    navigateWithTransition(`index.html#request-${requestId}`);
                } else {
                    window.location.href = `index.html#request-${requestId}`;
                }
            } else if (typeof window.openRequestDetail === "function") {
                window.openRequestDetail(requestId);
            } else if (typeof openRequestDetail === "function") {
                openRequestDetail(requestId);
            }
        }
    } catch (error) {
        console.error(error);
        alert(error.message || "Ошибка");
    }
}

async function confirmCompletionFromNotification(requestId, notificationId) {
    try {
        const headers = getHeaders();
        const res = await fetch(`${notificationsApiBase()}/requests/${requestId}/confirm-completion`, {
            method: "POST",
            headers: headers
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || `Ошибка ${res.status}`);
        }
        await fetch(`${notificationsApiBase()}/notifications/${notificationId}/read`, {
            method: "POST",
            headers: headers
        });
        await loadNotifications();
        updateUnreadBadge();
        if (typeof navigateWithTransition === "function") {
            navigateWithTransition(`index.html#request-${requestId}`);
        } else {
            window.location.href = `index.html#request-${requestId}`;
        }
    } catch (e) {
        console.error(e);
        alert(e.message || "Ошибка подтверждения");
    }
}

async function markAllNotificationsRead() {
    try {
        const response = await fetch(`${notificationsApiBase()}/notifications/read-all`, {
            method: "POST",
            headers: getHeaders()
        });
        if (!response.ok) {
            throw new Error("Ошибка при обновлении уведомлений");
        }
        await loadNotifications();
        updateUnreadBadge();
    } catch (error) {
        console.error("Ошибка:", error);
        alert(error.message || "Ошибка");
    }
}

async function updateUnreadBadge() {
    try {
        const headers = getHeaders();
        const response = await fetch(`${notificationsApiBase()}/notifications/unread-count`, {
            headers: headers
        });
        if (!response.ok) {
            return;
        }
        const data = await response.json();
        const badge = document.getElementById("messagesBadge");
        if (badge) {
            if (data.count > 0) {
                badge.textContent = data.count > 99 ? "99+" : data.count;
                badge.style.display = "inline-flex";
            } else {
                badge.style.display = "none";
            }
        }
    } catch (error) {
        console.error("Ошибка обновления бейджа:", error);
    }
}

function openMessagesModal() {
    window.location.href = "messages.html";
}

function closeMessagesModal() {}

function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text == null ? "" : String(text);
    return div.innerHTML;
}

function filterMessages() {
    const searchInput = document.getElementById("messagesSearchInput");
    const clearButton = document.getElementById("messagesSearchClear");
    if (!searchInput) return;
    const searchTerm = searchInput.value.trim();
    if (clearButton) {
        clearButton.style.display = searchTerm ? "flex" : "none";
    }
    applyFilters();
}

function clearSearch() {
    const searchInput = document.getElementById("messagesSearchInput");
    if (searchInput) {
        searchInput.value = "";
        filterMessages();
    }
}

async function dismissNotification(notificationId) {
    try {
        const headers = getHeaders();
        const response = await fetch(`${notificationsApiBase()}/notifications/${notificationId}`, {
            method: "DELETE",
            headers: headers
        });
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.detail || "Ошибка при удалении");
        }
        allNotifications = allNotifications.filter(n => n.id !== notificationId);
        applyFilters();
        updateUnreadBadge();
    } catch (error) {
        console.error(error);
        alert(error.message || "Ошибка");
    }
}

function initNotificationCenterTabs() {
    const tabs = document.querySelectorAll("[data-nc-tab]");
    if (!tabs.length) return;
    tabs.forEach(btn => {
        btn.addEventListener("click", () => {
            const tab = btn.getAttribute("data-nc-tab");
            if (!tab) return;
            currentTab = tab;
            tabs.forEach(b => {
                const active = b.getAttribute("data-nc-tab") === tab;
                b.classList.toggle("nc-tab--active", active);
                b.setAttribute("aria-selected", active ? "true" : "false");
            });
            applyFilters();
        });
    });
}

function initNotificationsOnLoad() {
    updateUnreadBadge();
    setInterval(updateUnreadBadge, 3e4);
    if (window.location.pathname.includes("messages.html") || window.location.href.includes("messages.html")) {
        loadNotifications();
        initNotificationCenterTabs();
    }
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initNotificationsOnLoad);
} else {
    initNotificationsOnLoad();
}

window.openNotification = openNotification;

window.markAllNotificationsRead = markAllNotificationsRead;

window.filterMessages = filterMessages;

window.clearSearch = clearSearch;

window.dismissNotification = dismissNotification;

window.deleteNotification = dismissNotification;

window.initNotificationCenterTabs = initNotificationCenterTabs;