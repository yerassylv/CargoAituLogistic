const REQUESTS_API_URL = "https://cargoaitulogistic.onrender.com/api";

const IS_DEVELOPMENT = typeof window !== "undefined" && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1" || localStorage.getItem("debug") === "true");

const debugLog = IS_DEVELOPMENT ? console.log.bind(console) : () => {};

const debugWarn = IS_DEVELOPMENT ? console.warn.bind(console) : () => {};

const debugError = console.error.bind(console);

let currentUser = null;

let currentFilterStatus = null;

let allRequests = [];

let currentSearchQuery = "";

let currentListMode = "all";

const requestCache = new Map;

const CACHE_TTL = 3e4;

let bidsRefreshInterval = null;

let bidsLoadInflightEntry = null;

const BID_PRICE_GRID_TENGE = 1e4;

function getRequestStatusLabelForCard(status) {
    switch (status) {
      case "active":
        return "Активна";

      case "in_progress":
        return "В работе";

      case "awaiting_carrier_confirmation":
        return "Ожидает ответа перевозчика";

      case "completed":
        return "Завершена";

      case "cancelled":
        return "Отменена";

      case "draft":
        return "Черновик";

      case "bidding_closed":
        return "Приём ставок закрыт";

      case "expired":
        return "Истекла";

      default:
        return "Другое";
    }
}

function getRequestStatusLabelForDetail(status) {
    switch (status) {
      case "active":
        return "Активна";

      case "in_progress":
        return "В работе";

      case "awaiting_carrier_confirmation":
        return "Ожидает ответа перевозчика";

      case "completed":
        return "Исполнена";

      case "cancelled":
        return "Отменена";

      case "draft":
        return "Черновик";

      case "bidding_closed":
        return "Приём ставок закрыт";

      case "expired":
        return "Истекла";

      default:
        return "Другое";
    }
}

function getRequestStatusPillSlug(status) {
    const known = [ "active", "in_progress", "completed", "cancelled", "awaiting_carrier_confirmation" ];
    return known.includes(status) ? status : "other";
}

function getRequestStatusDetailBadgeClass(status) {
    switch (status) {
      case "active":
        return "status-green";

      case "in_progress":
      case "awaiting_carrier_confirmation":
        return "status-orange";

      case "completed":
        return "status-blue";

      case "cancelled":
      case "expired":
        return "status-gray";

      default:
        return "status-gray";
    }
}

function getMetaBaseUrl() {
    if (typeof API_URL !== "undefined" && API_URL) {
        return API_URL.replace(/\/$/, "");
    }
    return "https://cargoaitulogistic.onrender.com";
}

async function loadRequestBodyTypeOptionsFromMeta() {
    const sel = document.getElementById("requestBodyType");
    if (!sel) return;
    const base = getMetaBaseUrl();
    try {
        const r = await fetch(`${base}/api/meta/vehicle-enums`);
        if (!r.ok) return;
        const data = await r.json();
        window._cargoBodyLabelMap = window._cargoBodyLabelMap || {};
        (data.cargo_body_type || []).forEach(function(x) {
            window._cargoBodyLabelMap[x.code] = x.label_ru;
        });
        sel.innerHTML = '<option value="">Выберите тип</option>';
        (data.cargo_body_type || []).forEach(function(x) {
            const o = document.createElement("option");
            o.value = x.code;
            o.textContent = x.label_ru;
            sel.appendChild(o);
        });
    } catch (e) {
        debugWarn("Не удалось загрузить типы кузова для заявки", e);
    }
}

function formatBodyTypeForDisplay(stored) {
    if (!stored) return "Не указан";
    if (window._cargoBodyLabelMap && window._cargoBodyLabelMap[stored]) {
        return window._cargoBodyLabelMap[stored];
    }
    const legacy = {
        tent: "Тент",
        refrigerator: "Рефрижератор",
        isothermal: "Изотермический",
        open: "Открытый"
    };
    if (legacy[stored]) return legacy[stored];
    return stored;
}

function isBidPriceOnGrid(price) {
    if (price == null || Number.isNaN(price)) return false;
    const tenge = Math.round(price);
    return tenge % BID_PRICE_GRID_TENGE === 0;
}

async function getRequest(id, forceRefresh = false, options = {}) {
    const includeBids = !!options.includeBids;
    const cacheKey = `request_${id}${includeBids ? "_wb" : ""}`;
    const cached = requestCache.get(cacheKey);
    if (!forceRefresh && cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return cached.data;
    }
    const q = includeBids ? "?include_bids=true" : "";
    const data = await apiFetch(`${REQUESTS_API_URL}/requests/${id}${q}`);
    requestCache.set(cacheKey, {
        data: data,
        timestamp: Date.now()
    });
    return data;
}

function invalidateRequestCache(id) {
    requestCache.delete(`request_${id}`);
    requestCache.delete(`request_${id}_wb`);
}

function applyRequestDetailHeader(request) {
    const numberEl = document.getElementById("detailRequestNumber");
    if (numberEl) {
        numberEl.textContent = `№${request.id}`;
        numberEl.classList.remove("skeleton-text", "fade-in");
    }
    const routeEl = document.getElementById("detailRequestRoute");
    if (routeEl) {
        routeEl.textContent = `${request.from_city} → ${request.to_city}`;
        routeEl.classList.remove("skeleton-text", "fade-in");
    }
    const statusText = getRequestStatusLabelForDetail(request.status);
    const statusClass = getRequestStatusDetailBadgeClass(request.status);
    const statusEl = document.getElementById("detailRequestStatus");
    if (statusEl) {
        statusEl.textContent = statusText;
        statusEl.className = `request-status-badge ${statusClass}`;
    }
    const priceEl = document.getElementById("detailRequestPrice");
    if (priceEl) {
        priceEl.textContent = request.max_price ? `${request.max_price.toLocaleString("ru-RU")} ₸` : "Договорная";
        priceEl.classList.remove("skeleton-text", "fade-in");
    }
}

function updateRequestDetailTabsVisibility(request) {
    const isInProgress = request.status === "in_progress";
    const isCompleted = request.status === "completed";
    const tabCarrier = document.getElementById("tabCarrier");
    if (tabCarrier) {
        if (isInProgress || isCompleted) {
            tabCarrier.style.display = "block";
        } else {
            tabCarrier.style.display = "none";
            const carrierSetupPanel = document.getElementById("carrierSetupPanel");
            if (carrierSetupPanel) carrierSetupPanel.style.display = "none";
        }
    }
    const tabContract = document.getElementById("tabContract");
    if (tabContract) {
        tabContract.style.display = request.contract_created_at ? "block" : "none";
    }
    const tabClosing = document.getElementById("tabClosing");
    if (tabClosing) {
        tabClosing.style.display = request.contract_created_at ? "block" : "none";
    }
    const auctionInfo = document.getElementById("auctionInfo");
    if (auctionInfo && !isCompleted) {
        auctionInfo.style.display = "block";
    } else if (auctionInfo && isCompleted) {
        auctionInfo.style.display = "none";
    }
}

async function refetchCurrentRequestDetail(requestId, opts = {}) {
    const {refreshList: refreshList = true, includeBids: includeBids = false, reloadHistory: reloadHistory = false, reloadContract: reloadContract = true} = opts;
    invalidateRequestCache(requestId);
    let updated;
    try {
        updated = await getRequest(requestId, true, {
            includeBids: includeBids
        });
    } catch (e) {
        console.error("[refetchCurrentRequestDetail]", e);
        throw e;
    }
    if (!updated) return null;
    const modal = document.getElementById("requestDetailModal");
    const modalOpen = modal && (modal.style.display === "flex" || window.getComputedStyle(modal).display === "flex");
    if (modalOpen && currentRequestDetail && currentRequestDetail.id === requestId) {
        currentRequestDetail = updated;
        applyRequestDetailHeader(updated);
        renderRequestDetail(updated);
        updateRequestDetailTabsVisibility(updated);
        [ "detailCarrierName", "detailCarrierINN", "detailCarrierPhone" ].forEach(id => {
            const el = document.getElementById(id);
            if (el) delete el.dataset.loaded;
        });
        await loadCarrierInfo(updated);
        const bidsTab = document.getElementById("tab-bids");
        if (bidsTab && bidsTab.classList.contains("active")) {
            await loadBidsForDetail(true);
        }
        if (reloadHistory) {
            tabLoadState.history = false;
            await loadRequestHistory();
        }
        if (reloadContract && updated.contract_created_at) {
            tabLoadState.contract = false;
            await loadContractInfo(requestId);
        }
    }
    if (refreshList) {
        await loadRequests(true);
    }
    return updated;
}

function loadUserData() {
    const userData = localStorage.getItem("user");
    if (userData) {
        currentUser = JSON.parse(userData);
        return currentUser;
    }
    return null;
}

function getHeaders() {
    const user = loadUserData();
    if (!user || !user.id) {
        throw new Error("Пользователь не авторизован");
    }
    const headers = {
        "Content-Type": "application/json",
        "X-User-Id": user.id.toString()
    };
    debugLog("Заголовки запроса:", headers);
    return headers;
}

function escapeHtmlBid(text) {
    if (text == null) return "";
    const s = String(text);
    const map = {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    };
    return s.replace(/[&<>"']/g, c => map[c]);
}

function escapeHtmlAttr(text) {
    if (text == null) return "";
    const s = String(text);
    const map = {
        "&": "&amp;",
        '"': "&quot;",
        "'": "&#39;",
        "<": "&lt;",
        ">": "&gt;"
    };
    return s.replace(/[&<>"']/g, c => map[c]);
}

function formatHttpErrorDetail(detail) {
    if (detail == null || detail === "") return "";
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) {
        return detail.map(item => {
            if (typeof item === "string") return item;
            if (item && typeof item.msg === "string") return item.msg;
            return "";
        }).filter(Boolean).join("; ");
    }
    if (typeof detail === "object") {
        if (typeof detail.message === "string") return detail.message;
        try {
            return JSON.stringify(detail);
        } catch {
            return "Ошибка запроса";
        }
    }
    return String(detail);
}

async function apiFetch(url, options = {}) {
    const res = await fetch(url, {
        credentials: "include",
        ...options,
        headers: {
            ...options.headers || {},
            ...options.withAuth !== false ? getHeaders() : {}
        }
    });
    if (!res.ok) {
        let message = `HTTP ${res.status}`;
        try {
            const data = await res.json();
            const fromDetail = formatHttpErrorDetail(data.detail);
            const fromMsg = typeof data.message === "string" ? data.message : "";
            message = fromDetail || fromMsg || message;
        } catch {
            try {
                const text = await res.text();
                if (text) message = text;
            } catch {}
        }
        throw new Error(message);
    }
    if (res.status === 204) return null;
    return res.json();
}

async function loadRequests(showIndicator = false) {
    try {
        const tbodyPre = document.getElementById("requestsTableBody");
        const skel = document.getElementById("tableSkeleton");
        if (tbodyPre && skel && !skel.classList.contains("hidden")) {
            tbodyPre.classList.add("table-body--loading");
        }
        if (showIndicator) {
            const indicator = document.getElementById("refreshIndicator");
            if (indicator) {
                indicator.classList.add("refreshing");
            }
        }
        const status = currentFilterStatus ? `?status=${currentFilterStatus}` : "";
        const url = `${REQUESTS_API_URL}/requests${status}`;
        debugLog("Загрузка заявок с URL:", url);
        const requests = await apiFetch(url);
        debugLog("Загружено заявок:", requests.length);
        const previousCount = allRequests.length;
        const countChanged = previousCount !== requests.length;
        allRequests = requests;
        displayRequests(getRequestsForDisplay());
        if (showIndicator) {
            const indicator = document.getElementById("refreshIndicator");
            if (indicator) {
                indicator.classList.remove("refreshing");
            }
        }
        if (previousCount > 0 && countChanged && requests.length > previousCount && typeof showSuccess === "function") {
            showSuccess(`Обновлено: появилось ${requests.length - previousCount} новых заявок`);
        }
        return requests;
    } catch (error) {
        console.error("Ошибка загрузки заявок:", error);
        if (showIndicator) {
            const indicator = document.getElementById("refreshIndicator");
            if (indicator) {
                indicator.classList.remove("refreshing");
            }
        }
        if (!showIndicator) {
            const skeleton = document.getElementById("tableSkeleton");
            if (skeleton) {
                skeleton.classList.add("hidden");
            }
            const errTbody = document.getElementById("requestsTableBody");
            if (errTbody) {
                errTbody.classList.remove("table-body--loading");
                errTbody.innerHTML = `\n      <div class="empty">\n        <div class="empty-icon"></div>\n        <div class="empty-title">Ошибка загрузки</div>\n        <div class="empty-text">${error.message}</div>\n      </div>\n    `;
            }
        }
        throw error;
    }
}

function getRequestsForDisplay() {
    loadUserData();
    let r = Array.isArray(allRequests) ? [ ...allRequests ] : [];
    if (currentListMode === "mine") {
        r = r.filter(req => currentUser && req.customer_id === currentUser.id);
    } else if (currentListMode === "participating") {
        r = r.filter(req => req.user_has_bid);
    }
    if (currentSearchQuery.trim()) {
        r = filterRequestsByQuery(r, currentSearchQuery);
    }
    r = applyAdvancedFilters(r);
    return r;
}

function applyAdvancedFilters(requests) {
    if (!requests || !requests.length) return requests;
    const fromQ = (document.getElementById("filterFromCity")?.value || "").trim().toLowerCase();
    const toQ = (document.getElementById("filterToCity")?.value || "").trim().toLowerCase();
    const priceMin = parseFloat(document.getElementById("filterPriceMin")?.value, 10);
    const priceMax = parseFloat(document.getElementById("filterPriceMax")?.value, 10);
    const dateFrom = document.getElementById("filterDateFrom")?.value;
    const dateTo = document.getElementById("filterDateTo")?.value;
    return requests.filter(req => {
        if (fromQ && !String(req.from_city || "").toLowerCase().includes(fromQ)) return false;
        if (toQ && !String(req.to_city || "").toLowerCase().includes(toQ)) return false;
        if (!Number.isNaN(priceMin) && priceMin > 0) {
            if (req.max_price == null || req.max_price < priceMin) return false;
        }
        if (!Number.isNaN(priceMax) && priceMax > 0) {
            if (req.max_price == null || req.max_price > priceMax) return false;
        }
        if (dateFrom) {
            const ld = new Date(req.loading_date);
            const df = new Date(dateFrom + "T00:00:00");
            if (ld < df) return false;
        }
        if (dateTo) {
            const ld = new Date(req.loading_date);
            const dt = new Date(dateTo + "T23:59:59.999");
            if (ld > dt) return false;
        }
        return true;
    });
}

function updateMarketTitles() {
    const title = document.getElementById("requestsMarketTitle");
    const sub = document.getElementById("requestsMarketSubtitle");
    if (!title || !sub) return;
    if (currentListMode === "mine") {
        title.textContent = "Мои заявки";
        sub.textContent = "Ваши заявки как заказчик";
    } else if (currentListMode === "participating") {
        title.textContent = "Я участвую";
        sub.textContent = "Заявки, по которым вы сделали ставку";
    } else {
        title.textContent = "Биржа грузов";
        sub.textContent = "Грузы и заявки на перевозку";
    }
}

function formatFoundRequestsRu(n) {
    const k = Math.floor(Math.abs(Number(n)));
    const v = k % 100;
    const l = v % 10;
    const nStr = k.toLocaleString("ru-RU");
    if (v > 10 && v < 20) return `${nStr} заявок`;
    if (l === 1) return `${nStr} заявка`;
    if (l >= 2 && l <= 4) return `${nStr} заявки`;
    return `${nStr} заявок`;
}

function updateRequestsMarketCount(n) {
    const el = document.getElementById("requestsMarketCount");
    if (!el) return;
    el.textContent = `Найдено: ${formatFoundRequestsRu(n)}`;
}

function setRequestListMode(mode) {
    if (![ "all", "mine", "participating" ].includes(mode)) return;
    currentListMode = mode;
    document.querySelectorAll(".market-tab[data-list-mode]").forEach(el => {
        const active = el.dataset.listMode === mode;
        el.classList.toggle("market-tab--active", active);
        el.setAttribute("aria-selected", active ? "true" : "false");
    });
    updateMarketTitles();
    displayRequests(getRequestsForDisplay());
}

function resetMarketFilters() {
    [ "filterFromCity", "filterToCity", "filterPriceMin", "filterPriceMax", "filterDateFrom", "filterDateTo" ].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = "";
    });
    document.querySelectorAll(".market-quick-chip--active").forEach(el => el.classList.remove("market-quick-chip--active"));
    displayRequests(getRequestsForDisplay());
}

function toggleMarketFiltersPanel() {
    const panel = document.getElementById("marketFiltersPanel");
    const btn = document.getElementById("marketFiltersToggle");
    if (!panel || !btn) return;
    const wasCollapsed = panel.classList.contains("market-filters-panel--collapsed");
    panel.classList.toggle("market-filters-panel--collapsed", !wasCollapsed);
    const nowCollapsed = panel.classList.contains("market-filters-panel--collapsed");
    btn.setAttribute("aria-expanded", nowCollapsed ? "false" : "true");
    const chev = btn.querySelector(".market-filters-toggle-chevron");
    if (chev) chev.textContent = nowCollapsed ? "▼" : "▲";
}

function applyMarketQuickFilter(kind) {
    const map = {
        today: () => {
            const d = new Date;
            const iso = d.toISOString().slice(0, 10);
            const df = document.getElementById("filterDateFrom");
            const dt = document.getElementById("filterDateTo");
            if (df) df.value = iso;
            if (dt) dt.value = iso;
        },
        price500k: () => {
            const maxEl = document.getElementById("filterPriceMax");
            const minEl = document.getElementById("filterPriceMin");
            if (maxEl) maxEl.value = "500000";
            if (minEl) minEl.value = "";
        },
        "route-aa": () => {
            setRouteQuick("Алматы", "Астана");
        },
        "route-sa": () => {
            setRouteQuick("Астана", "Алматы");
        },
        "route-as": () => {
            setRouteQuick("Алматы", "Шымкент");
        }
    };
    function setRouteQuick(from, to) {
        const a = document.getElementById("filterFromCity");
        const b = document.getElementById("filterToCity");
        if (a) a.value = from;
        if (b) b.value = to;
    }
    document.querySelectorAll(".market-quick-chip").forEach(c => c.classList.remove("market-quick-chip--active"));
    const chip = document.querySelector(`.market-quick-chip[data-quick="${kind}"]`);
    if (chip) chip.classList.add("market-quick-chip--active");
    const fn = map[kind];
    if (fn) fn();
    displayRequests(getRequestsForDisplay());
}

function displayRequests(requests) {
    loadUserData();
    const tbody = document.getElementById("requestsTableBody");
    if (!tbody) return;
    tbody.classList.remove("table-body--loading");
    const skeleton = document.getElementById("tableSkeleton");
    if (skeleton) {
        skeleton.classList.add("hidden");
    }
    if (!requests || requests.length === 0) {
        updateRequestsMarketCount(0);
        let emptyTitle = "Нет заявок по фильтрам";
        let emptyText = "Измените фильтры или сбросьте расширенный поиск";
        if (currentListMode === "mine") {
            emptyTitle = "У вас пока нет заявок";
            emptyText = "Создайте заявку — перевозчики увидят её на бирже";
        } else if (currentListMode === "participating") {
            emptyTitle = "Вы ещё не участвуете";
            emptyText = "Откройте «Все заявки» и нажмите «Сделать ставку»";
        } else if (!allRequests || allRequests.length === 0) {
            emptyTitle = "Пока нет заявок";
            emptyText = "Создайте первую заявку или дождитесь новых на бирже";
        }
        tbody.innerHTML = `\n      <div class="empty empty--marketplace">\n        <div class="empty-icon"></div>\n        <div class="empty-title">${emptyTitle}</div>\n        <div class="empty-text">${emptyText}</div>\n        <div class="empty-actions">\n          <button type="button" class="btn-create btn-create--empty" onclick="openCreateModal()">\n            <span class="btn-icon">+</span> Создать заявку\n          </button>\n        </div>\n      </div>\n    `;
        return;
    }
    updateRequestsMarketCount(requests.length);
    const fragment = document.createDocumentFragment();
    requests.forEach(request => {
        const loadingDate = new Date(request.loading_date).toLocaleDateString("ru-RU");
        const statusText = getRequestStatusLabelForCard(request.status);
        const statusSlug = getRequestStatusPillSlug(request.status);
        const isOwner = currentUser && currentUser.id === request.customer_id;
        const isSelectedCarrier = currentUser && request.selected_carrier_id && currentUser.id === request.selected_carrier_id;
        const hasBid = request.user_has_bid || false;
        const isInProgress = request.status === "in_progress";
        const isCompleted = request.status === "completed";
        const hasSelectedCarrier = request.selected_carrier_id || request.selected_bid_id;
        const bidsCount = request.bids_count != null ? request.bids_count : 0;
        let primaryCta = "";
        let secondaryHint = "";
        if (isOwner) {
            if (isCompleted) {
                primaryCta = '<span class="request-card__state-done">Исполнена</span>';
            } else if (isInProgress || hasSelectedCarrier) {
                primaryCta = '<span class="request-card__state-done">Перевозчик выбран</span>';
            } else {
                const n = bidsCount;
                if (n > 0) {
                    primaryCta = `<button type="button" class="request-card__cta request-card__cta--primary" onclick="event.stopPropagation(); viewBids(${request.id})">Смотреть предложения (${n})</button>`;
                } else {
                    primaryCta = `<div class="request-card__neutral-box"><p class="request-card__neutral-msg">Пока нет предложений от перевозчиков. Заявка опубликована на бирже — отклики появятся здесь.</p></div>`;
                }
            }
        } else if (isSelectedCarrier) {
            if (isCompleted) {
                primaryCta = '<span class="request-card__state-done">Исполнена</span>';
            } else if (request.status === "awaiting_carrier_confirmation") {
                primaryCta = `\n          <div class="request-card__cta-pair" role="group" aria-label="Ответ на выбор заказчика">\n            <button type="button" class="request-card__cta request-card__cta--primary" onclick="event.stopPropagation(); carrierAcceptRequest(${request.id})">Подтвердить заказ</button>\n            <button type="button" class="request-card__cta request-card__cta--secondary" onclick="event.stopPropagation(); carrierDeclineRequest(${request.id})">Отказаться</button>\n          </div>`;
            } else if (isInProgress) {
                const hasDriver = request.assigned_driver_id;
                const hasVehicle = request.assigned_vehicle_id;
                const hasContract = request.contract_created_at;
                if (hasDriver && hasVehicle && hasContract) {
                    primaryCta = `<button type="button" class="request-card__cta request-card__cta--primary" onclick="event.stopPropagation(); completeRequest(${request.id})">Завершить перевозку</button>`;
                } else {
                    primaryCta = `<button type="button" class="request-card__cta request-card__cta--secondary" onclick="event.stopPropagation(); openRequestDetailAndSwitchToCarrier(${request.id})">Настроить перевозку</button>`;
                }
            }
        } else if (request.status === "active" && !hasBid) {
            primaryCta = `<button type="button" class="request-card__cta request-card__cta--primary" onclick="event.stopPropagation(); openBidModal(${request.id})">Сделать ставку</button>`;
        } else if (hasBid) {
            primaryCta = '<span class="request-card__state-bid">Ваша ставка подана</span>';
        } else if (hasSelectedCarrier) {
            primaryCta = '<span class="request-card__state-muted">Перевозчик выбран</span>';
        }
        const canDelete = isOwner && request.status === "active" && !hasSelectedCarrier;
        const customerLine = !isOwner && request.customer_name ? `<div class="request-card__customer">Заказчик: <strong>${escapeHtmlBid(request.customer_name)}</strong></div>` : !isOwner ? '<div class="request-card__customer">Заказчик: <span class="request-card__anon">Компания на платформе</span></div>' : "";
        const distLine = request.distance_km ? `${request.distance_km.toLocaleString("ru-RU", {
            maximumFractionDigits: 1
        })} км` : "—";
        const priceLine = request.max_price ? `${request.max_price.toLocaleString("ru-RU")} ₸` : "Договорная";
        const priceValueHtml = request.max_price ? `<span class="request-card__price-value">${priceLine}</span>` : `<span class="request-card__price-value request-card__price-value--contract">${priceLine}</span>`;
        const expressTag = request.is_express ? '<span class="request-card__express">Экспресс</span>' : "";
        const icDist = '<svg class="request-card__svg request-card__svg--muted" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12h4l3.5 10 4-20 3.5 10H21"/></svg>';
        const icCal = '<svg class="request-card__svg request-card__svg--muted" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>';
        const wrapper = document.createElement("div");
        wrapper.className = "request-card-wrapper" + (isOwner ? " request-card-wrapper--mine" : " request-card-wrapper--market");
        wrapper.dataset.requestId = request.id;
        wrapper.dataset.canDelete = canDelete ? "true" : "false";
        wrapper.innerHTML = `\n        <div class="request-card" data-request-id="${request.id}">\n          <div class="request-card__top">\n            <div class="request-card__labels">\n              <span class="request-card__pill request-card__pill--role ${isOwner ? "request-card__pill--role-owner" : "request-card__pill--role-market"}">${isOwner ? "Моя заявка" : "На бирже"}</span>\n              <span class="request-card__pill request-card__pill--status request-card__pill--status-${statusSlug}">${statusText}</span>\n              ${isOwner && request.status === "active" && !hasSelectedCarrier && bidsCount > 0 ? `<span class="request-card__pill request-card__pill--bids">${bidsCount} ${bidsCount === 1 ? "предложение" : bidsCount > 1 && bidsCount < 5 ? "предложения" : "предложений"}</span>` : ""}\n            </div>\n            <div class="request-card__top-actions">\n              ${canDelete ? `\n                <button type="button" class="request-card__icon-del" onclick="event.stopPropagation(); deleteRequest(${request.id})" title="Удалить заявку">\n                  <svg width="18" height="18" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5 7.5L5 15.5C5 16.3284 5.67157 17 6.5 17H13.5C14.3284 17 15 16.3284 15 15.5V7.5M12.5 7.5V5.5C12.5 4.67157 11.8284 4 11 4H9C8.17157 4 7.5 4.67157 7.5 5.5V7.5M3 7.5H17M8.75 10V14.5M11.25 10V14.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>\n                </button>\n              ` : `<span class="request-card__id">#${request.id}</span>`}\n            </div>\n          </div>\n          <div class="request-card__hero">\n            <div class="request-card__price-col">\n              <span class="request-card__price-label">Стоимость</span>\n              <div class="request-card__price-shell">\n                <div class="request-card__price-line">${priceValueHtml}${expressTag ? ` ${expressTag}` : ""}</div>\n              </div>\n            </div>\n            <div class="request-card__route-col">\n              <span class="request-card__eyebrow">Маршрут</span>\n              <div class="request-card__route">${escapeHtmlBid(request.from_city)} <span class="request-card__arrow">→</span> ${escapeHtmlBid(request.to_city)}</div>\n            </div>\n          </div>\n          <div class="request-card__meta-row" aria-label="Детали">\n            <span class="request-card__meta-item">${icDist}<span class="request-card__meta-text">${distLine}</span></span>\n            <span class="request-card__meta-sep" aria-hidden="true">·</span>\n            <span class="request-card__meta-item">${icCal}<span class="request-card__meta-text">${loadingDate}</span></span>\n          </div>\n          ${customerLine}\n          <div class="request-card__footer">\n            ${primaryCta || '<span class="request-card__state-muted">Нет действий</span>'}\n            ${secondaryHint}\n          </div>\n        </div>\n        ${canDelete ? `\n          <div class="request-card-delete">\n            <button type="button" class="btn-delete-swipe" data-request-id="${request.id}" title="Удалить заявку">\n              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">\n                <path d="M5 7.5L5 15.5C5 16.3284 5.67157 17 6.5 17H13.5C14.3284 17 15 16.3284 15 15.5V7.5M12.5 7.5V5.5C12.5 4.67157 11.8284 4 11 4H9C8.17157 4 7.5 4.67157 7.5 5.5V7.5M3 7.5H17M8.75 10V14.5M11.25 10V14.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>\n              </svg>\n            </button>\n          </div>\n        ` : ""}\n    `;
        fragment.appendChild(wrapper);
    });
    document.querySelectorAll(".request-card-wrapper").forEach(w => {
        if (w._closeSwipeHandler) {
            document.removeEventListener("click", w._closeSwipeHandler, true);
            delete w._closeSwipeHandler;
        }
        if (w._touchStartHandler) {
            w.removeEventListener("touchstart", w._touchStartHandler);
            delete w._touchStartHandler;
        }
        if (w._touchMoveHandler) {
            w.removeEventListener("touchmove", w._touchMoveHandler);
            delete w._touchMoveHandler;
        }
        if (w._touchEndHandler) {
            w.removeEventListener("touchend", w._touchEndHandler);
            delete w._touchEndHandler;
        }
        if (w._mouseDownHandler) {
            w.removeEventListener("mousedown", w._mouseDownHandler);
            delete w._mouseDownHandler;
        }
        if (w._mouseMoveHandler) {
            w.removeEventListener("mousemove", w._mouseMoveHandler);
            delete w._mouseMoveHandler;
        }
        if (w._mouseUpHandler) {
            w.removeEventListener("mouseup", w._mouseUpHandler);
            delete w._mouseUpHandler;
        }
        if (w._mouseLeaveHandler) {
            w.removeEventListener("mouseleave", w._mouseLeaveHandler);
            delete w._mouseLeaveHandler;
        }
    });
    tbody.replaceChildren(fragment);
    requestAnimationFrame(() => {
        initSwipeHandlers();
    });
}

function handleRowClick(e) {
    const card = e.target.closest(".request-card[data-request-id]");
    if (!card) return;
    if (e.target.closest("button") || e.target.closest(".btn-bid") || e.target.closest(".request-card__cta") || e.target.closest(".btn-outline") || e.target.closest(".btn-delete-swipe") || e.target.closest(".request-card-delete") || e.target.closest(".request-card__icon-del")) {
        return;
    }
    const wrapper = card.closest(".request-card-wrapper");
    if (wrapper?.classList.contains("swiped")) return;
    if (wrapper?._isSwiping) return;
    const requestId = parseInt(card.dataset.requestId, 10);
    if (requestId) {
        openRequestDetail(requestId);
    }
}

function initSwipeHandlers() {
    const wrappers = document.querySelectorAll('.request-card-wrapper[data-can-delete="true"]');
    const SWIPE_THRESHOLD = 12;
    wrappers.forEach(wrapper => {
        let startX = 0;
        let currentX = 0;
        let startTime = 0;
        let isSwiping = false;
        let hasSwiped = false;
        const row = wrapper.querySelector(".request-card");
        const deleteArea = wrapper.querySelector(".request-card-delete");
        const deleteButton = deleteArea ? deleteArea.querySelector(".btn-delete-swipe") : null;
        if (!deleteArea || !deleteButton) return;
        wrapper._isSwiping = false;
        if (deleteButton) {
            deleteButton.addEventListener("click", e => {
                e.stopPropagation();
                e.preventDefault();
                const requestId = parseInt(wrapper.dataset.requestId);
                if (requestId) {
                    deleteRequest(requestId);
                }
                wrapper.classList.remove("swiped");
                row.style.transform = "translateX(0)";
                deleteArea.style.opacity = "0";
                hasSwiped = false;
                wrapper._isSwiping = false;
            });
        }
        const touchStartHandler = e => {
            const target = e.target;
            if (target.closest("button") || target.closest(".btn-bid") || target.closest(".request-card__cta") || target.closest(".btn-outline") || target.closest("a") || target.tagName === "BUTTON" || target.tagName === "A") {
                return;
            }
            startX = e.touches[0].clientX;
            currentX = e.touches[0].clientX;
            startTime = Date.now();
            isSwiping = false;
            hasSwiped = false;
        };
        const touchMoveHandler = e => {
            currentX = e.touches[0].clientX;
            const diff = startX - currentX;
            if (Math.abs(diff) < SWIPE_THRESHOLD) {
                return;
            }
            if (diff > SWIPE_THRESHOLD) {
                isSwiping = true;
                wrapper._isSwiping = true;
            }
            if (isSwiping && diff > 0) {
                const translateX = Math.min(diff, 80);
                row.style.transform = `translateX(-${translateX}px)`;
                deleteArea.style.opacity = Math.min(diff / 80, 1);
            } else if (isSwiping && diff <= 0) {
                row.style.transform = "translateX(0)";
                deleteArea.style.opacity = "0";
                wrapper.classList.remove("swiped");
            }
        };
        const touchEndHandler = e => {
            const diff = startX - currentX;
            const timeDiff = Date.now() - startTime;
            if (isSwiping && diff > 80 && timeDiff > 250) {
                hasSwiped = true;
                wrapper._isSwiping = true;
                wrapper.classList.add("swiped");
                row.style.transform = "translateX(-80px)";
                deleteArea.style.opacity = "1";
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            hasSwiped = false;
            wrapper._isSwiping = false;
            wrapper.classList.remove("swiped");
            if (isSwiping) {
                row.style.transform = "translateX(0)";
                deleteArea.style.opacity = "0";
            } else {
                row.style.transform = "";
                deleteArea.style.opacity = "";
            }
            isSwiping = false;
        };
        let mouseDown = false;
        const mouseDownHandler = e => {
            const target = e.target;
            if (target.closest("button") || target.closest(".btn-bid") || target.closest(".request-card__cta") || target.closest(".btn-outline") || target.closest("a") || target.tagName === "BUTTON" || target.tagName === "A") {
                return;
            }
            if (e.button !== 0) return;
            startX = e.clientX;
            currentX = e.clientX;
            startTime = Date.now();
            mouseDown = true;
            isSwiping = false;
            hasSwiped = false;
        };
        const mouseMoveHandler = e => {
            if (!mouseDown) return;
            currentX = e.clientX;
            const diff = startX - currentX;
            if (Math.abs(diff) < SWIPE_THRESHOLD) {
                return;
            }
            if (diff > SWIPE_THRESHOLD) {
                isSwiping = true;
                wrapper._isSwiping = true;
            }
            if (isSwiping && diff > 0) {
                const translateX = Math.min(diff, 80);
                row.style.transform = `translateX(-${translateX}px)`;
                deleteArea.style.opacity = Math.min(diff / 80, 1);
            } else if (isSwiping && diff <= 0) {
                row.style.transform = "translateX(0)";
                deleteArea.style.opacity = "0";
                wrapper.classList.remove("swiped");
            }
        };
        const mouseUpHandler = e => {
            if (!mouseDown) return;
            mouseDown = false;
            const diff = startX - currentX;
            const timeDiff = Date.now() - startTime;
            if (isSwiping && diff > 80 && timeDiff > 250) {
                hasSwiped = true;
                wrapper._isSwiping = true;
                wrapper.classList.add("swiped");
                row.style.transform = "translateX(-80px)";
                deleteArea.style.opacity = "1";
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            hasSwiped = false;
            wrapper._isSwiping = false;
            wrapper.classList.remove("swiped");
            if (isSwiping) {
                row.style.transform = "translateX(0)";
                deleteArea.style.opacity = "0";
            } else {
                row.style.transform = "";
                deleteArea.style.opacity = "";
            }
            isSwiping = false;
        };
        const mouseLeaveHandler = () => {
            if (mouseDown) {
                mouseDown = false;
                const diff = startX - currentX;
                const timeDiff = Date.now() - startTime;
                if (diff > 80 && isSwiping && timeDiff > 250) {
                    hasSwiped = true;
                    wrapper._isSwiping = true;
                    wrapper.classList.add("swiped");
                    row.style.transform = "translateX(-80px)";
                    deleteArea.style.opacity = "1";
                } else {
                    hasSwiped = false;
                    wrapper._isSwiping = false;
                    wrapper.classList.remove("swiped");
                    row.style.transform = "translateX(0)";
                    deleteArea.style.opacity = "0";
                }
                isSwiping = false;
            }
        };
        wrapper.addEventListener("touchstart", touchStartHandler, {
            passive: true
        });
        wrapper._touchStartHandler = touchStartHandler;
        wrapper.addEventListener("touchmove", touchMoveHandler, {
            passive: true
        });
        wrapper._touchMoveHandler = touchMoveHandler;
        wrapper.addEventListener("touchend", touchEndHandler, {
            passive: false
        });
        wrapper._touchEndHandler = touchEndHandler;
        wrapper.addEventListener("mousedown", mouseDownHandler);
        wrapper._mouseDownHandler = mouseDownHandler;
        wrapper.addEventListener("mousemove", mouseMoveHandler);
        wrapper._mouseMoveHandler = mouseMoveHandler;
        wrapper.addEventListener("mouseup", mouseUpHandler);
        wrapper._mouseUpHandler = mouseUpHandler;
        wrapper.addEventListener("mouseleave", mouseLeaveHandler);
        wrapper._mouseLeaveHandler = mouseLeaveHandler;
        const closeSwipeHandler = e => {
            if (deleteButton && deleteButton.contains(e.target)) {
                return;
            }
            if (!wrapper.contains(e.target) && wrapper.classList.contains("swiped")) {
                hasSwiped = false;
                wrapper._isSwiping = false;
                wrapper.classList.remove("swiped");
                row.style.transform = "translateX(0)";
                deleteArea.style.opacity = "0";
            }
        };
        document.addEventListener("click", closeSwipeHandler, true);
        wrapper._closeSwipeHandler = closeSwipeHandler;
    });
}

function filterByStatus(status, element) {
    currentFilterStatus = status;
    document.querySelectorAll(".filter-tags .tag").forEach(tag => tag.classList.remove("active"));
    if (element) {
        element.classList.add("active");
    } else if (event && event.target) {
        event.target.classList.add("active");
    }
    loadRequests();
}

function bindCreateRequestMapLazyTriggers() {
    const form = document.getElementById("createRequestForm");
    if (!form || form.dataset.mapLazyBound === "1") return;
    form.dataset.mapLazyBound = "1";
    const trigger = () => {
        ensureCreateRequestMapLoaded();
    };
    [ "requestFromCity", "requestToCity", "requestFromAddress", "requestToAddress" ].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener("focus", trigger, {
            passive: true
        });
    });
    const mapHost = document.getElementById("createRequestMap");
    if (mapHost) {
        mapHost.addEventListener("click", trigger);
    }
}

function ensureCreateRequestMapLoaded() {
    if (window.__createRequestMapFullyReady) return;
    const finish = () => {
        if (window.__createRequestMapFullyReady) return;
        if (typeof initCreateRequestMap === "function") {
            initCreateRequestMap();
        }
        if (typeof setupMapListeners === "function") {
            setupMapListeners();
        }
        requestAnimationFrame(() => {
            if (typeof updateCreateRequestRoute === "function") {
                updateCreateRequestRoute();
            }
        });
        window.__createRequestMapFullyReady = true;
    };
    if (window.googleMapsLoaded && typeof google !== "undefined" && google.maps) {
        setTimeout(finish, 0);
        return;
    }
    if (typeof window.loadGoogleMaps === "function") {
        window.loadGoogleMaps().then(() => {
            setTimeout(finish, 100);
        }).catch(error => {
            debugWarn("Не удалось загрузить Google Maps:", error);
        });
    }
}

function openCreateModal() {
    const modal = document.getElementById("createRequestModal");
    if (!modal) {
        console.error("Модальное окно создания заявки не найдено");
        return;
    }
    const alreadyOpen = modal.style.display === "flex" || window.getComputedStyle(modal).display === "flex";
    if (alreadyOpen) {
        return;
    }
    modal.style.display = "flex";
    lockBodyScroll();
    const now = new Date;
    const defaultEndTime = new Date(now.getTime() + 24 * 60 * 60 * 1e3);
    const formatDateTimeLocal = date => {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, "0");
        const day = String(date.getDate()).padStart(2, "0");
        const hours = String(date.getHours()).padStart(2, "0");
        const minutes = String(date.getMinutes()).padStart(2, "0");
        return `${year}-${month}-${day}T${hours}:${minutes}`;
    };
    const biddingEndsAtField = document.getElementById("requestBiddingEndsAt");
    if (biddingEndsAtField && !biddingEndsAtField.value) {
        biddingEndsAtField.value = formatDateTimeLocal(defaultEndTime);
    }
    const expressCheckbox = document.getElementById("requestIsExpress");
    if (expressCheckbox && biddingEndsAtField) {
        expressCheckbox.onchange = function() {
            if (!biddingEndsAtField.value || biddingEndsAtField.value === formatDateTimeLocal(defaultEndTime)) {
                const hours = this.checked ? 2 : 24;
                const newEndTime = new Date(now.getTime() + hours * 60 * 60 * 1e3);
                biddingEndsAtField.value = formatDateTimeLocal(newEndTime);
            }
        };
    }
    bindCreateRequestMapLazyTriggers();
}

function closeCreateModal() {
    const modal = document.getElementById("createRequestModal");
    if (modal) {
        modal.style.display = "none";
        unlockBodyScroll();
    }
    const form = document.getElementById("createRequestForm");
    if (form) {
        form.reset();
    }
}

let currentRequestDetail = null;

let currentRequestController = null;

function showDetailSkeleton() {
    const detailSkeleton = document.getElementById("detailSkeleton");
    if (detailSkeleton) {
        detailSkeleton.classList.remove("hidden");
    }
    document.querySelectorAll(".tab-content").forEach(tab => {
        tab.style.display = "none";
    });
    const highPriorityFields = [ "detailRequestNumber", "detailRequestRoute", "detailRequestPrice", "detailRequestStatus" ];
    highPriorityFields.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.classList.remove("skeleton-text", "fade-in", "visible");
        }
    });
    const skeletonFields = [ "detailRequestDates", "detailTitle", "detailCustomer", "detailBodyType", "detailCargoType", "detailWeight", "detailVolume", "detailFrom", "detailTo", "detailFromAddress", "detailToAddress", "detailMaxPrice", "detailCreatedAt", "detailConditions", "detailDescription" ];
    skeletonFields.forEach(id => {
        const el = document.getElementById(id);
        if (el && !el.dataset.loaded) {
            el.classList.add("skeleton-text");
            el.textContent = "";
        }
    });
    const mapContainer = document.getElementById("detailRequestMap");
    if (mapContainer && !mapContainer.dataset.loaded) {
        mapContainer.classList.add("skeleton-map");
    }
}

const tabLoadState = {
    info: false,
    carrier: false,
    bids: false,
    history: false,
    contract: false,
    closing: false
};

function renderRequestDetail(request) {
    const detailSkeleton = document.getElementById("detailSkeleton");
    if (detailSkeleton) {
        detailSkeleton.classList.add("hidden");
    }
    const activeTab = document.querySelector(".tab-content.active");
    if (activeTab) {
        activeTab.style.display = "block";
    }
    const loadingDate = new Date(request.loading_date).toLocaleString("ru-RU");
    const deliveryDate = request.delivery_date ? new Date(request.delivery_date).toLocaleString("ru-RU") : "Не указана";
    const datesEl = document.getElementById("detailRequestDates");
    if (datesEl) {
        datesEl.classList.remove("skeleton-text");
        datesEl.innerHTML = `Погрузка <strong>${loadingDate}</strong> · Доставка <strong>${deliveryDate}</strong>`;
    }
    const fillField = (id, value) => {
        const el = document.getElementById(id);
        if (el) {
            el.classList.remove("skeleton-text");
            el.textContent = value;
        }
    };
    fillField("detailTitle", request.title || "-");
    fillField("detailCustomer", request.customer_name || "-");
    fillField("detailBodyType", formatBodyTypeForDisplay(request.body_type));
    fillField("detailCargoType", request.cargo_type || "-");
    fillField("detailWeight", request.cargo_weight ? `${request.cargo_weight.toLocaleString("ru-RU")} кг` : "-");
    fillField("detailVolume", request.cargo_volume ? `${request.cargo_volume.toLocaleString("ru-RU")} м³` : "-");
    fillField("detailFrom", request.from_city || "-");
    fillField("detailTo", request.to_city || "-");
    fillField("detailFromAddress", request.from_address || "Не указан");
    fillField("detailToAddress", request.to_address || "Не указан");
    const distanceElement = document.getElementById("detailDistance");
    if (distanceElement) {
        distanceElement.classList.remove("skeleton-text");
        if (request.distance_km) {
            distanceElement.textContent = `${request.distance_km.toLocaleString("ru-RU")} км`;
            distanceElement.parentElement.style.display = "block";
        } else {
            distanceElement.textContent = "Не рассчитано";
            distanceElement.parentElement.style.display = "block";
        }
    }
    fillField("detailMaxPrice", request.max_price ? `${request.max_price.toLocaleString("ru-RU")} ₸` : "Не указана");
    fillField("detailCreatedAt", new Date(request.created_at).toLocaleString("ru-RU"));
    const condEl = document.getElementById("detailConditions");
    if (condEl) {
        condEl.classList.remove("skeleton-text");
        const rawC = (request.conditions || "").trim();
        if (!rawC) {
            condEl.textContent = "Не указаны";
            condEl.classList.add("conditions-content--empty");
        } else {
            condEl.textContent = rawC;
            condEl.classList.remove("conditions-content--empty");
        }
    }
    const descEl = document.getElementById("detailDescription");
    if (descEl) {
        descEl.classList.remove("skeleton-text");
        const rawD = (request.description || "").trim();
        if (!rawD) {
            descEl.textContent = "Не указано";
            descEl.classList.add("conditions-content--empty");
        } else {
            descEl.textContent = rawD;
            descEl.classList.remove("conditions-content--empty");
        }
    }
    const mapTitle = document.getElementById("detailRouteMapTitle");
    const mapMeta = document.getElementById("detailRouteMapMeta");
    if (mapTitle) {
        mapTitle.classList.remove("skeleton-text");
        mapTitle.textContent = `${request.from_city || "—"} → ${request.to_city || "—"}`;
    }
    if (mapMeta) {
        mapMeta.classList.remove("skeleton-text");
        const dist = request.distance_km != null ? `${Number(request.distance_km).toLocaleString("ru-RU", {
            maximumFractionDigits: 1
        })} км` : "—";
        const ld = request.loading_date ? new Date(request.loading_date).toLocaleString("ru-RU", {
            day: "numeric",
            month: "short",
            hour: "2-digit",
            minute: "2-digit"
        }) : "—";
        mapMeta.textContent = `${dist} · Погрузка ${ld}`;
    }
    const elements = document.querySelectorAll('#requestDetailModal [id^="detail"]');
    elements.forEach(el => {
        if (el.id && !el.id.includes("Map") && el.textContent && el.textContent !== "-") {
            if (!el.innerHTML.includes("skeleton")) {
                el.dataset.loaded = "1";
            }
        }
    });
}

async function openRequestDetail(requestId) {
    try {
        if (currentRequestController) {
            currentRequestController.abort();
        }
        currentRequestController = new AbortController;
        const signal = currentRequestController.signal;
        const modal = document.getElementById("requestDetailModal");
        modal.style.display = "flex";
        lockBodyScroll();
        const requestPromise = getRequest(requestId, false, {
            includeBids: false
        });
        showDetailSkeleton();
        requestPromise.then(request2 => {
            if (signal.aborted) return;
            applyRequestDetailHeader(request2);
        }).catch(err => {
            console.error("Ошибка загрузки HIGH PRIORITY данных:", err);
        });
        const request = await requestPromise;
        if (signal.aborted) return;
        currentRequestDetail = request;
        renderRequestDetail(request);
        const userStr = localStorage.getItem("user");
        const currentUser2 = userStr ? JSON.parse(userStr) : null;
        const isWinner = currentUser2 && request.selected_carrier_id === currentUser2.id;
        const isInProgress = request.status === "in_progress";
        const isAwaitingCarrier = request.status === "awaiting_carrier_confirmation";
        const carrierAwaitBanner = document.getElementById("carrierAwaitingBanner");
        if (carrierAwaitBanner) {
            carrierAwaitBanner.style.display = isWinner && isAwaitingCarrier ? "block" : "none";
        }
        const tabDocuments = document.getElementById("tabDocuments");
        updateRequestDetailTabsVisibility(request);
        const isCompleted = request.status === "completed";
        const tabCarrier = document.getElementById("tabCarrier");
        if (isInProgress || isCompleted) {
            const carrierNameEl = document.getElementById("detailCarrierName");
            if (carrierNameEl && !carrierNameEl.dataset.loaded) {
                carrierNameEl.innerHTML = '<span class="skeleton skeleton-text">Загрузка...</span>';
            }
        }
        if (tabDocuments) {
            tabDocuments.style.display = "none";
        }
        const bidsList = document.getElementById("bidsList");
        if (bidsList && !bidsList.dataset.loaded) {
            bidsList.innerHTML = '<div style="text-align: center; padding: 20px;"><span class="skeleton skeleton-text">Загрузка ставок...</span></div>';
        }
        const historyList = document.getElementById("historyList");
        if (historyList && !historyList.dataset.loaded) {
            historyList.innerHTML = '<div style="text-align: center; padding: 20px;"><span class="skeleton skeleton-text">Загрузка истории...</span></div>';
        }
        tabLoadState.info = false;
        tabLoadState.carrier = false;
        tabLoadState.bids = false;
        tabLoadState.history = false;
        tabLoadState.contract = false;
        tabLoadState.closing = false;
        const shouldSwitchToCarrier = window._pendingTabSwitch === "carrier";
        if (shouldSwitchToCarrier) {
            window._pendingTabSwitch = null;
            requestAnimationFrame(() => {
                requestAnimationFrame(() => switchTab("carrier"));
            });
        } else {
            switchTab("info");
            if ((isInProgress || isCompleted) && request.selected_carrier_id) {
                loadCarrierInfo(request).catch(err => {
                    console.error("Ошибка предзагрузки информации о перевозчике:", err);
                });
            }
        }
    } catch (error) {
        console.error("Ошибка загрузки заявки:", error);
        document.getElementById("requestDetailModal").style.display = "none";
        if (typeof showError === "function") {
            showError(error.message);
        } else {
            if (typeof showError === "function") {
                showError(error.message);
            }
        }
    }
}

function closeRequestDetailModal() {
    if (currentRequestController) {
        currentRequestController.abort();
        currentRequestController = null;
    }
    if (bidsRefreshInterval) {
        clearInterval(bidsRefreshInterval);
        bidsRefreshInterval = null;
    }
    const modal = document.getElementById("requestDetailModal");
    modal.style.display = "none";
    currentRequestDetail = null;
    const detailSkeleton = document.getElementById("detailSkeleton");
    if (detailSkeleton) {
        detailSkeleton.classList.add("hidden");
    }
    unlockBodyScroll();
    tabLoadState.info = false;
    tabLoadState.carrier = false;
    tabLoadState.bids = false;
    tabLoadState.history = false;
    tabLoadState.contract = false;
    tabLoadState.closing = false;
    const elements = document.querySelectorAll("#requestDetailModal [data-loaded]");
    elements.forEach(el => {
        delete el.dataset.loaded;
        el.classList.remove("skeleton-text", "fade-in", "visible");
    });
    const mapContainer = document.getElementById("detailRequestMap");
    if (mapContainer) {
        mapContainer.classList.remove("skeleton-map");
        mapContainer.dataset.loaded = "";
    }
}

async function switchTab(tabName) {
    const detailSkeleton = document.getElementById("detailSkeleton");
    if (detailSkeleton && currentRequestDetail) {
        detailSkeleton.classList.add("hidden");
    }
    document.querySelectorAll(".tab-content").forEach(tab => {
        tab.classList.remove("active");
        tab.style.display = "none";
    });
    document.querySelectorAll(".tab-btn").forEach(btn => {
        btn.classList.remove("active");
    });
    const selectedTab = document.getElementById(`tab-${tabName}`);
    if (selectedTab) {
        selectedTab.classList.add("active");
        selectedTab.style.display = "block";
    }
    const selectedBtn = document.querySelector(`[data-tab="${tabName}"]`);
    if (selectedBtn) {
        selectedBtn.classList.add("active");
    }
    if (!currentRequestDetail) return;
    if (tabName === "info" && !tabLoadState.info && currentRequestDetail) {
        tabLoadState.info = true;
        const initMap = () => {
            const mapContainer = document.getElementById("detailRequestMap");
            if (!mapContainer) {
                debugWarn("Контейнер карты не найден, повторная попытка через 100ms");
                setTimeout(initMap, 100);
                return;
            }
            const containerStyle = window.getComputedStyle(mapContainer);
            if (containerStyle.display === "none") {
                debugWarn("Контейнер карты скрыт, повторная попытка через 100ms");
                setTimeout(initMap, 100);
                return;
            }
            if (typeof window.loadGoogleMaps === "function") {
                window.loadGoogleMaps().then(() => {
                    setTimeout(() => {
                        if (typeof initDetailRequestMap === "function" && currentRequestDetail) {
                            debugLog("Инициализация карты для заявки:", currentRequestDetail.id);
                            initDetailRequestMap(currentRequestDetail.from_city, currentRequestDetail.to_city, currentRequestDetail.from_address, currentRequestDetail.to_address);
                        } else {
                            debugWarn("initDetailRequestMap не доступна или currentRequestDetail отсутствует");
                        }
                    }, 300);
                }).catch(error => {
                    debugWarn("Не удалось загрузить Google Maps:", error);
                });
            } else if (window.googleMapsLoaded || typeof google !== "undefined" && google.maps) {
                setTimeout(() => {
                    if (typeof initDetailRequestMap === "function" && currentRequestDetail) {
                        debugLog("Инициализация карты для заявки:", currentRequestDetail.id);
                        initDetailRequestMap(currentRequestDetail.from_city, currentRequestDetail.to_city, currentRequestDetail.from_address, currentRequestDetail.to_address);
                    } else {
                        debugWarn("initDetailRequestMap не доступна или currentRequestDetail отсутствует");
                    }
                }, 300);
            } else {
                debugLog("Ожидание загрузки Google Maps...");
                let attempts = 0;
                const maxAttempts = 100;
                const checkInterval = setInterval(() => {
                    attempts++;
                    if (window.googleMapsLoaded || typeof google !== "undefined" && google.maps) {
                        clearInterval(checkInterval);
                        setTimeout(() => {
                            if (typeof initDetailRequestMap === "function" && currentRequestDetail) {
                                debugLog("Google Maps загружен, инициализация карты");
                                initDetailRequestMap(currentRequestDetail.from_city, currentRequestDetail.to_city, currentRequestDetail.from_address, currentRequestDetail.to_address);
                            }
                        }, 300);
                    } else if (attempts >= maxAttempts) {
                        clearInterval(checkInterval);
                        console.error("Google Maps не загрузился за 10 секунд");
                        const mapContainer2 = document.getElementById("detailRequestMap");
                        if (mapContainer2) {
                            mapContainer2.innerHTML = '<div style="display: flex; align-items: center; justify-content: center; height: 100%; color: #6b7280;">Ошибка загрузки карты. Обновите страницу.</div>';
                        }
                    }
                }, 100);
            }
        };
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                initMap();
            });
        });
    } else if (tabName === "info" && tabLoadState.info && currentRequestDetail) {
        if (typeof initDetailRequestMap === "function" && (window.googleMapsLoaded || typeof google !== "undefined" && google.maps)) {
            setTimeout(() => {
                initDetailRequestMap(currentRequestDetail.from_city, currentRequestDetail.to_city, currentRequestDetail.from_address, currentRequestDetail.to_address);
            }, 100);
        }
    }
    if (tabName === "carrier" && !tabLoadState.carrier) {
        tabLoadState.carrier = true;
        const carrierNameEl = document.getElementById("detailCarrierName");
        if (carrierNameEl && !carrierNameEl.dataset.loaded) {
            carrierNameEl.innerHTML = '<span class="skeleton skeleton-text">Загрузка...</span>';
        }
        loadCarrierInfo(currentRequestDetail).catch(err => {
            console.error("Ошибка загрузки информации о перевозчике:", err);
            if (carrierNameEl && !carrierNameEl.dataset.loaded) {
                carrierNameEl.textContent = "Ошибка загрузки";
            }
        });
    }
    if (tabName === "bids" && !tabLoadState.bids) {
        tabLoadState.bids = true;
        const bidsList = document.getElementById("bidsList");
        if (bidsList && !bidsList.dataset.loaded) {
            bidsList.innerHTML = '<div style="text-align: center; padding: 20px;"><span class="skeleton skeleton-text">Загрузка ставок...</span></div>';
        }
        loadBidsForDetail().catch(err => {
            console.error("Ошибка загрузки ставок:", err);
            if (bidsList) {
                bidsList.innerHTML = '<div style="text-align: center; padding: 20px; color: #ef4444;">Ошибка загрузки ставок</div>';
            }
        });
    } else if (tabName === "bids") {
        loadBidsForDetail(true).catch(err => {
            console.error("Ошибка обновления ставок:", err);
        });
    } else {
        if (bidsRefreshInterval) {
            clearInterval(bidsRefreshInterval);
            bidsRefreshInterval = null;
        }
    }
    if (tabName === "history" && !tabLoadState.history) {
        tabLoadState.history = true;
        const historyList = document.getElementById("historyList");
        if (historyList && !historyList.dataset.loaded) {
            historyList.innerHTML = '<div style="text-align: center; padding: 20px;"><span class="skeleton skeleton-text">Загрузка истории...</span></div>';
        }
        loadRequestHistory().catch(err => {
            console.error("Ошибка загрузки истории:", err);
            if (historyList && !historyList.dataset.loaded) {
                historyList.innerHTML = '<div style="text-align: center; padding: 20px; color: #ef4444;">Ошибка загрузки истории</div>';
            }
        });
    }
    if (tabName === "contract" && !tabLoadState.contract && currentRequestDetail.contract_created_at) {
        tabLoadState.contract = true;
        loadContractInfo(currentRequestDetail.id).catch(err => {
            console.error("Ошибка загрузки информации о контракте:", err);
        });
    }
    if (tabName === "closing" && !tabLoadState.closing) {
        tabLoadState.closing = true;
        loadClosingInfo(currentRequestDetail.id).catch(err => {
            console.error("Ошибка загрузки информации о закрытии:", err);
        });
    }
}

async function loadBidsForDetail(showIndicator = false) {
    if (!currentRequestDetail) return;
    const rid = currentRequestDetail.id;
    const run = async () => {
        try {
            if (showIndicator) {
                const bidsList2 = document.getElementById("bidsList");
                if (bidsList2 && bidsList2.querySelector(".bid-item")) {
                    bidsList2.classList.add("refreshing");
                }
            }
            let bids;
            if (Array.isArray(currentRequestDetail.bids)) {
                bids = [ ...currentRequestDetail.bids ];
                delete currentRequestDetail.bids;
            } else {
                const response = await fetch(`${REQUESTS_API_URL}/requests/${rid}/bids`, {
                    headers: getHeaders()
                });
                if (!response.ok) {
                    throw new Error("Ошибка загрузки ставок");
                }
                bids = await response.json();
            }
            const previousBidsCount = parseInt(document.getElementById("bidsCount").textContent) || 0;
            document.getElementById("bidsCount").textContent = bids.length;
            const bidsList = document.getElementById("bidsList");
            let auctionInfoHTML = "";
            if (currentRequestDetail.bidding_ends_at) {
                const endsAt = new Date(currentRequestDetail.bidding_ends_at);
                const now = new Date;
                const timeRemaining = endsAt - now;
                const serverSaysOpen = currentRequestDetail.bidding_accepting === void 0 || currentRequestDetail.bidding_accepting === null ? null : currentRequestDetail.bidding_accepting;
                if (serverSaysOpen === false) {
                    auctionInfoHTML = `\n          <div class="rd-auction-note">\n            <div class="rd-auction-note__title">Приём ставок закрыт</div>\n            <p class="rd-auction-note__sub">Окончание: ${endsAt.toLocaleString("ru-RU")}</p>\n          </div>\n        `;
                } else if (timeRemaining > 0) {
                    const hours = Math.floor(timeRemaining / (1e3 * 60 * 60));
                    const minutes = Math.floor(timeRemaining % (1e3 * 60 * 60) / (1e3 * 60));
                    const seconds = Math.floor(timeRemaining % (1e3 * 60) / 1e3);
                    const timeRemainingText = hours > 0 ? `${hours} ч ${minutes} мин` : minutes > 0 ? `${minutes} мин ${seconds} сек` : `${seconds} сек`;
                    const isUrgent = timeRemaining < 5 * 60 * 1e3;
                    auctionInfoHTML = `\n          <div class="rd-auction-note ${isUrgent ? "rd-auction-note--urgent" : "rd-auction-note--live"}">\n            <div class="rd-auction-note__title">Аукцион до ${endsAt.toLocaleString("ru-RU")}</div>\n            <p class="rd-auction-note__sub">Осталось: ${timeRemainingText}</p>\n          </div>\n        `;
                } else {
                    auctionInfoHTML = `\n          <div class="rd-auction-note">\n            <div class="rd-auction-note__title">Аукцион завершён</div>\n          </div>\n        `;
                }
            }
            if (bids.length === 0) {
                bidsList.innerHTML = `\n        ${auctionInfoHTML}\n        <div class="empty">\n          <div class="empty-icon"></div>\n          <div class="empty-title">Нет ставок</div>\n          <div class="empty-text">Пока никто не подал предложение на эту заявку</div>\n        </div>\n      `;
                return;
            }
            const user = loadUserData();
            const isOwner = user && user.id === currentRequestDetail.customer_id;
            const sortedBids = [ ...bids ].sort((a, b) => a.price - b.price);
            bidsList.innerHTML = auctionInfoHTML + sortedBids.map((bid, index) => {
                const bidTime = new Date(bid.created_at).toLocaleString("ru-RU");
                const updatedTime = bid.updated_at ? new Date(bid.updated_at).toLocaleString("ru-RU") : null;
                const isWinner = bid.is_selected;
                const isMyBid = user && bid.carrier_id === user.id;
                const biddingOpen = currentRequestDetail.bidding_accepting === void 0 || currentRequestDetail.bidding_accepting === null ? true : currentRequestDetail.bidding_accepting;
                const canEdit = isMyBid && bid.is_active && !isWinner && currentRequestDetail.status === "active" && biddingOpen;
                const isBestPrice = index === 0 && !isWinner;
                let carrierLine = "";
                if (isOwner) {
                    carrierLine = `<div class="bid-item__carrier">${escapeHtmlBid(bid.carrier_name || bid.carrier_company || "Перевозчик")}</div>`;
                } else if (isMyBid) {
                    carrierLine = '<div class="bid-item__carrier bid-item__carrier--accent">Ваша ставка</div>';
                } else {
                    carrierLine = '<div class="bid-item__carrier bid-item__carrier--muted">Другой перевозчик</div>';
                }
                const timeInfo = updatedTime && updatedTime !== bidTime ? `<div class="bid-item__updated">Обновлено ${updatedTime}</div>` : "";
                const bestBadge = isBestPrice && !isWinner ? '<span class="bid-item__badge bid-item__badge--best">Лучшая цена</span>' : "";
                const winnerBadge = isWinner ? '<span class="bid-item__badge bid-item__badge--winner">Победитель</span>' : "";
                const youBadge = isMyBid ? '<span class="bid-item__badge bid-item__badge--you">Вы</span>' : "";
                const metaBits = [];
                if (bid.price_per_km) metaBits.push(`${bid.price_per_km.toLocaleString("ru-RU")} ₸/км`);
                if (bid.delivery_time) metaBits.push(bid.delivery_time);
                if (bid.vehicle_info) metaBits.push(bid.vehicle_info);
                const metaRow = metaBits.length ? `<div class="bid-item__meta-row">${metaBits.map(t => escapeHtmlBid(t)).join(" · ")}</div>` : "";
                return `\n        <div class="bid-item ${isWinner ? "bid-winner" : ""} ${isMyBid ? "bid-my" : ""} ${isBestPrice ? "bid-best-price" : ""}">\n          <div class="bid-item__row">\n            <div class="bid-item__price">${bid.price.toLocaleString("ru-RU")} ₸</div>\n            <div class="bid-item__badges">${winnerBadge}${youBadge}${bestBadge}</div>\n          </div>\n          <div class="bid-item__meta">\n            ${carrierLine}\n            ${metaRow}\n            <div class="bid-item__subtle">Подано ${bidTime}</div>\n            ${timeInfo}\n            ${canEdit ? `<div class="bid-item__actions"><button type="button" class="btn-outline" onclick="editBid(${bid.id}, ${currentRequestDetail.id})">Изменить ставку</button></div>` : ""}\n          </div>\n        </div>\n      `;
            }).join("");
            if (bidsList) {
                bidsList.dataset.loaded = "1";
                bidsList.classList.remove("refreshing");
            }
        } catch (error) {
            console.error("Ошибка загрузки ставок:", error);
            const bidsList = document.getElementById("bidsList");
            if (bidsList) {
                bidsList.classList.remove("refreshing");
                if (!bidsList.dataset.loaded) {
                    bidsList.innerHTML = `\n        <div class="empty">\n          <div class="empty-icon"></div>\n          <div class="empty-title">Ошибка загрузки</div>\n          <div class="empty-text">${error.message}</div>\n        </div>\n      `;
                }
            }
        }
    };
    if (bidsLoadInflightEntry && bidsLoadInflightEntry.requestId === rid) {
        return bidsLoadInflightEntry.promise;
    }
    const promise = run();
    const entry = {
        requestId: rid,
        promise: promise
    };
    bidsLoadInflightEntry = entry;
    promise.finally(() => {
        if (bidsLoadInflightEntry === entry) {
            bidsLoadInflightEntry = null;
        }
    });
    return promise;
}

async function resolveDriverDisplayForRequest(request) {
    if (!request.assigned_driver_id) return null;
    if (request.assigned_driver_name) {
        let driverInfo = request.assigned_driver_name;
        if (request.assigned_driver_birth_date) {
            const birthDate = new Date(request.assigned_driver_birth_date).toLocaleDateString("ru-RU");
            driverInfo += `, дата рождения ${birthDate}`;
        }
        if (request.assigned_driver_phone) {
            driverInfo += `, тел.: ${request.assigned_driver_phone}`;
        }
        return driverInfo;
    }
    try {
        const driver = await apiFetch(`${API_URL}/api/drivers/${request.assigned_driver_id}`);
        let driverInfo = driver.full_name;
        if (driver.birth_date) {
            const birthDate = new Date(driver.birth_date).toLocaleDateString("ru-RU");
            driverInfo += `, дата рождения ${birthDate}`;
        }
        if (driver.phone) {
            driverInfo += `, тел.: ${driver.phone}`;
        }
        return driverInfo;
    } catch (error) {
        console.error("Ошибка загрузки информации о водителе:", error);
        return "Данные водителя временно недоступны";
    }
}

async function resolveVehiclePartsForRequest(request) {
    if (!request.assigned_vehicle_id) return null;
    if (request.assigned_vehicle_info) {
        return {
            plate: request.assigned_vehicle_info,
            model: request.assigned_vehicle_model || "—",
            type: request.assigned_vehicle_type || formatBodyTypeForDisplay(request.body_type)
        };
    }
    try {
        const vehicle = await apiFetch(`${API_URL}/api/vehicles/${request.assigned_vehicle_id}`);
        const vehicleParts = [];
        if (vehicle.tractor_brand && vehicle.tractor_license_plate) {
            vehicleParts.push(`${vehicle.tractor_brand} ${vehicle.tractor_license_plate}`);
        }
        if (vehicle.trailer_brand && vehicle.trailer_license_plate) {
            vehicleParts.push(`${vehicle.trailer_brand} ${vehicle.trailer_license_plate}`);
        }
        const plate = vehicleParts.length > 0 ? vehicleParts.join(", ") : `ID: ${vehicle.id}`;
        const model = vehicleParts.length > 0 ? vehicleParts[0] : "—";
        const type = formatBodyTypeForDisplay(vehicle.cargo_body_type || vehicle.body_type) || vehicle.composition_label_ru || vehicle.vehicle_type || "—";
        return {
            plate: plate,
            model: model,
            type: type
        };
    } catch (error) {
        console.error("Ошибка загрузки информации о машине:", error);
        return {
            plate: "Данные машины временно недоступны",
            model: "—",
            type: formatBodyTypeForDisplay(request.body_type)
        };
    }
}

function carrierSetupNext() {
    if (!currentRequestDetail) return;
    if (!currentRequestDetail.assigned_vehicle_id) {
        openAssignVehicleModal();
    } else if (!currentRequestDetail.assigned_driver_id) {
        openAssignDriverModal();
    }
}

async function renderCarrierSetupUI(request) {
    const panel = document.getElementById("carrierSetupPanel");
    const phaseLine = document.getElementById("carrierSetupPhaseLine");
    const stepsEl = document.getElementById("carrierSetupSteps");
    const alertEl = document.getElementById("carrierSetupAlert");
    const mainCta = document.getElementById("carrierSetupMainCta");
    const subactions = document.getElementById("carrierSetupSubactions");
    const summaryEl = document.getElementById("carrierSetupSummary");
    const contractEl = document.getElementById("carrierSetupContract");
    if (!panel) return;
    const user = typeof loadUserData === "function" ? loadUserData() : null;
    const isWinner = user && request.selected_carrier_id === user.id;
    const isInProgress = request.status === "in_progress";
    const isCompleted = request.status === "completed";
    if (!request.selected_carrier_id || !isWinner) {
        panel.style.display = "none";
        return;
    }
    if (!isInProgress && !isCompleted) {
        panel.style.display = "none";
        return;
    }
    panel.style.display = "block";
    const hasV = !!request.assigned_vehicle_id;
    const hasD = !!request.assigned_driver_id;
    const setupComplete = hasV && hasD;
    let vehicleShort = "Требуется выбрать";
    let driverShort = "Требуется выбрать";
    let vehicleParts = null;
    let driverFull = null;
    if (hasV) {
        vehicleParts = await resolveVehiclePartsForRequest(request);
        vehicleShort = vehicleParts ? vehicleParts.plate : "Выбрано";
    }
    if (hasD) {
        driverFull = await resolveDriverDisplayForRequest(request);
        driverShort = driverFull ? driverFull.split(",")[0].trim() : "Выбрано";
    }
    if (phaseLine) {
        if (isCompleted) {
            phaseLine.textContent = "Заявка завершена — данные по перевозке";
        } else if (!hasV && !hasD) {
            phaseLine.textContent = "Состояние: не начато — требуется выбрать машину и водителя";
        } else if (setupComplete) {
            phaseLine.textContent = "Состояние: завершено — машина и водитель выбраны";
        } else {
            phaseLine.textContent = "Состояние: в процессе — осталось завершить настройку";
        }
    }
    if (stepsEl) {
        const vHint = !hasV ? "Требуется выбрать" : escapeHtmlBid(vehicleShort);
        const dHint = !hasD ? "Требуется выбрать" : escapeHtmlBid(driverShort);
        stepsEl.innerHTML = `\n      <div class="carrier-setup-step ${hasV ? "carrier-setup-step--done" : "carrier-setup-step--todo"}">\n        <span class="carrier-setup-step__icon" aria-hidden="true">${hasV ? "✓" : "○"}</span>\n        <div class="carrier-setup-step__body">\n          <div class="carrier-setup-step__title">Машина</div>\n          <div class="carrier-setup-step__hint">${vHint}</div>\n        </div>\n      </div>\n      <div class="carrier-setup-step ${hasD ? "carrier-setup-step--done" : "carrier-setup-step--todo"}">\n        <span class="carrier-setup-step__icon" aria-hidden="true">${hasD ? "✓" : "○"}</span>\n        <div class="carrier-setup-step__body">\n          <div class="carrier-setup-step__title">Водитель</div>\n          <div class="carrier-setup-step__hint">${dHint}</div>\n        </div>\n      </div>\n    `;
    }
    if (alertEl) alertEl.innerHTML = "";
    if (mainCta) mainCta.innerHTML = "";
    if (subactions) subactions.innerHTML = "";
    if (summaryEl) {
        summaryEl.innerHTML = "";
        summaryEl.hidden = true;
    }
    if (contractEl) contractEl.innerHTML = "";
    function fillSummaryCard(title) {
        if (!summaryEl || !vehicleParts || !driverFull) return;
        summaryEl.hidden = false;
        summaryEl.innerHTML = `\n      <div class="carrier-setup-summary-card">\n        <h4 class="carrier-setup-summary-title">${escapeHtmlBid(title)}</h4>\n        <dl class="carrier-setup-dl">\n          <dt>Номер / состав</dt><dd>${escapeHtmlBid(vehicleParts.plate)}</dd>\n          <dt>Модель</dt><dd>${escapeHtmlBid(vehicleParts.model)}</dd>\n          <dt>Тип</dt><dd>${escapeHtmlBid(vehicleParts.type)}</dd>\n          <dt>Водитель</dt><dd>${escapeHtmlBid(driverFull)}</dd>\n        </dl>\n      </div>\n    `;
    }
    if (isCompleted) {
        if (setupComplete && vehicleParts && driverFull) {
            fillSummaryCard("Перевозка");
        } else if (!setupComplete) {
            if (alertEl) {
                alertEl.innerHTML = '<div class="carrier-setup-alert-inner carrier-setup-alert-inner--muted"><p>По этой заявке не указаны машина и водитель в системе.</p></div>';
            }
        }
        if (request.contract_created_at && contractEl) {
            const contractDate = new Date(request.contract_created_at).toLocaleString("ru-RU");
            contractEl.innerHTML = `\n        <div class="carrier-setup-contract-box carrier-setup-contract-box--done">\n          <span class="carrier-setup-contract-box__icon" aria-hidden="true">✓</span>\n          <div>\n            <strong>Контракт создан</strong>\n            <div class="carrier-setup-contract-box__meta">Дата: ${escapeHtmlBid(contractDate)}</div>\n          </div>\n        </div>\n      `;
        }
        return;
    }
    if (!isInProgress) return;
    if (!setupComplete) {
        if (!hasV && !hasD) {
            if (alertEl) {
                alertEl.innerHTML = `\n      <div class="carrier-setup-alert-inner">\n        <strong>Необходимо настроить перевозку</strong>\n        <p>Выберите машину и водителя — это следующий шаг после подтверждения заказа.</p>\n      </div>\n    `;
            }
            if (mainCta) {
                mainCta.innerHTML = '<button type="button" class="btn-login carrier-setup-btn-primary" onclick="carrierSetupNext()">Назначить машину и водителя</button>';
            }
            if (subactions) subactions.innerHTML = "";
        } else if (!hasV) {
            if (alertEl) {
                alertEl.innerHTML = `\n      <div class="carrier-setup-alert-inner">\n        <strong>Выберите машину</strong>\n        <p>Без машины нельзя продолжить перевозку.</p>\n      </div>\n    `;
            }
            if (mainCta) {
                mainCta.innerHTML = '<button type="button" class="btn-login carrier-setup-btn-primary" onclick="openAssignVehicleModal()">Выбрать машину</button>';
            }
            if (subactions) {
                subactions.innerHTML = '<button type="button" class="btn-secondary" onclick="openAssignDriverModal()">Выбрать водителя</button>';
            }
        } else if (!hasD) {
            if (alertEl) {
                alertEl.innerHTML = `\n      <div class="carrier-setup-alert-inner">\n        <strong>Выберите водителя</strong>\n        <p>Осталось выбрать водителя для этой заявки.</p>\n      </div>\n    `;
            }
            if (mainCta) {
                mainCta.innerHTML = '<button type="button" class="btn-login carrier-setup-btn-primary" onclick="openAssignDriverModal()">Выбрать водителя</button>';
            }
            if (subactions) {
                subactions.innerHTML = '<button type="button" class="btn-secondary" onclick="openAssignVehicleModal()">Изменить машину</button>';
            }
        }
        return;
    }
    fillSummaryCard("Готово к работе");
    if (!contractEl) return;
    if (!request.contract_created_at) {
        contractEl.innerHTML = `\n      <div class="carrier-setup-contract-box carrier-setup-contract-box--cta">\n        <p class="carrier-setup-contract-box__lead">Следующий шаг — создать договор-заявку.</p>\n        <button type="button" class="btn-login" onclick="document.getElementById('btnCreateContract').click()">Создать договор-заявку</button>\n      </div>\n    `;
    } else {
        const contractDate = new Date(request.contract_created_at).toLocaleString("ru-RU");
        contractEl.innerHTML = `\n      <div class="carrier-setup-contract-box carrier-setup-contract-box--done">\n        <span class="carrier-setup-contract-box__icon" aria-hidden="true">✓</span>\n        <div>\n          <strong>Контракт создан</strong>\n          <div class="carrier-setup-contract-box__meta">Дата: ${escapeHtmlBid(contractDate)}</div>\n        </div>\n      </div>\n    `;
    }
}

async function loadCarrierInfo(request) {
    debugLog("[loadCarrierInfo] Начало загрузки данных перевозчика для заявки:", request?.id);
    const carrierNameEl = document.getElementById("detailCarrierName");
    const carrierINNEl = document.getElementById("detailCarrierINN");
    const carrierPhoneEl = document.getElementById("detailCarrierPhone");
    if (!request.selected_carrier_id) {
        debugLog("[loadCarrierInfo] Перевозчик не выбран");
        if (carrierNameEl && !carrierNameEl.dataset.loaded) {
            carrierNameEl.textContent = "Не выбран";
            carrierNameEl.dataset.loaded = "1";
        }
        if (carrierINNEl && !carrierINNEl.dataset.loaded) {
            carrierINNEl.textContent = "-";
            carrierINNEl.dataset.loaded = "1";
        }
        if (carrierPhoneEl && !carrierPhoneEl.dataset.loaded) {
            carrierPhoneEl.textContent = "-";
            carrierPhoneEl.dataset.loaded = "1";
        }
        await renderCarrierSetupUI(request);
        return;
    }
    const embedded = request.selected_carrier_company_name != null || request.selected_carrier_full_name != null || request.selected_carrier_phone != null || request.selected_carrier_iin != null;
    try {
        if (embedded) {
            const displayName = request.selected_carrier_company_name || request.selected_carrier_full_name || "Не указано";
            if (carrierNameEl && !carrierNameEl.dataset.loaded) {
                carrierNameEl.textContent = displayName;
                carrierNameEl.dataset.loaded = "1";
            }
            if (carrierINNEl && !carrierINNEl.dataset.loaded) {
                carrierINNEl.textContent = request.selected_carrier_iin || "Не указан";
                carrierINNEl.dataset.loaded = "1";
            }
            if (carrierPhoneEl && !carrierPhoneEl.dataset.loaded) {
                carrierPhoneEl.textContent = request.selected_carrier_phone || "Не указан";
                carrierPhoneEl.dataset.loaded = "1";
            }
        } else {
            debugLog("[loadCarrierInfo] Загрузка данных перевозчика ID:", request.selected_carrier_id);
            const carrier = await apiFetch(`${API_URL}/api/users/${request.selected_carrier_id}`);
            debugLog("[loadCarrierInfo] Данные перевозчика получены:", carrier);
            if (carrierNameEl && !carrierNameEl.dataset.loaded) {
                carrierNameEl.textContent = carrier.company_name || carrier.full_name || "Не указано";
                carrierNameEl.dataset.loaded = "1";
            }
            if (carrierINNEl && !carrierINNEl.dataset.loaded) {
                carrierINNEl.textContent = carrier.iin || "Не указан";
                carrierINNEl.dataset.loaded = "1";
            }
            if (carrierPhoneEl && !carrierPhoneEl.dataset.loaded) {
                carrierPhoneEl.textContent = carrier.phone || "Не указан";
                carrierPhoneEl.dataset.loaded = "1";
            }
        }
    } catch (error) {
        console.error("[loadCarrierInfo] Ошибка загрузки информации о перевозчике:", error);
        if (carrierNameEl && !carrierNameEl.dataset.loaded) {
            carrierNameEl.textContent = "Ошибка загрузки";
            carrierNameEl.dataset.loaded = "1";
        }
    }
    debugLog("[loadCarrierInfo] Загрузка данных завершена");
    await renderCarrierSetupUI(request);
}

async function refreshCarrierData() {
    if (!currentRequestDetail) return;
    try {
        await refetchCurrentRequestDetail(currentRequestDetail.id, {
            refreshList: true,
            reloadHistory: true,
            reloadContract: true
        });
    } catch (error) {
        console.error("Ошибка обновления данных перевозчика:", error);
    }
}

window.openCreateModal = openCreateModal;

window.closeCreateModal = closeCreateModal;

window.createRequest = createRequest;

window.openBidModal = openBidModal;

window.editBid = editBid;

window.closeBidModal = closeBidModal;

window.submitBid = submitBid;

window.viewBids = viewBids;

window.loadRequests = loadRequests;

window.filterByStatus = filterByStatus;

function openRequestDetailAndSwitchToCarrier(requestId) {
    window._pendingTabSwitch = "carrier";
    openRequestDetail(requestId);
}

window.openRequestDetail = openRequestDetail;

window.openRequestDetailAndSwitchToCarrier = openRequestDetailAndSwitchToCarrier;

window.closeRequestDetailModal = closeRequestDetailModal;

window.switchTab = switchTab;

window.closeSelectWinnerModal = closeSelectWinnerModal;

window.autoSelectWinner = autoSelectWinner;

window.confirmWinnerPickerSelection = confirmWinnerPickerSelection;

window.selectWinner = selectWinner;

window.viewCarrierInfo = viewCarrierInfo;

window.closeCarrierInfoModal = closeCarrierInfoModal;

window.backFromCarrierInWinnerModal = backFromCarrierInWinnerModal;

window.deleteRequest = deleteRequest;

window.carrierSetupNext = carrierSetupNext;

async function createRequest(event2) {
    if (event2) {
        event2.preventDefault();
    }
    try {
        const user = loadUserData();
        if (!user) {
            if (typeof showWarning === "function") {
                showWarning("Необходимо авторизоваться");
            } else {
                if (typeof showWarning === "function") {
                    showWarning("Необходимо авторизоваться");
                }
            }
            return;
        }
        const loadingDateValue = document.getElementById("requestLoadingDate").value;
        const deliveryDateValue = document.getElementById("requestDeliveryDate").value;
        if (!loadingDateValue) {
            throw new Error("Дата погрузки обязательна для заполнения");
        }
        const loadingDate = new Date(loadingDateValue);
        if (isNaN(loadingDate.getTime())) {
            throw new Error("Неверный формат даты погрузки");
        }
        const deliveryDate = deliveryDateValue && deliveryDateValue.trim() !== "" ? new Date(deliveryDateValue) : null;
        if (deliveryDate && isNaN(deliveryDate.getTime())) {
            throw new Error("Неверный формат даты доставки");
        }
        const biddingStartedAtValue = document.getElementById("requestBiddingStartedAt").value;
        const biddingEndsAtValue = document.getElementById("requestBiddingEndsAt").value;
        const biddingStartedAt = biddingStartedAtValue ? new Date(biddingStartedAtValue) : null;
        const biddingEndsAt = biddingEndsAtValue ? new Date(biddingEndsAtValue) : null;
        if (biddingStartedAt && isNaN(biddingStartedAt.getTime())) {
            throw new Error("Неверный формат времени начала аукциона");
        }
        if (biddingEndsAt && isNaN(biddingEndsAt.getTime())) {
            throw new Error("Неверный формат времени окончания аукциона");
        }
        if (biddingStartedAt && biddingEndsAt && biddingEndsAt <= biddingStartedAt) {
            throw new Error("Окончание приёма ставок должно быть позже начала");
        }
        const maxP = document.getElementById("requestMaxPrice").value ? parseFloat(document.getElementById("requestMaxPrice").value) : null;
        const requestData = {
            title: document.getElementById("requestTitle").value,
            description: document.getElementById("requestDescription").value || null,
            from_city: document.getElementById("requestFromCity").value,
            to_city: document.getElementById("requestToCity").value,
            from_address: document.getElementById("requestFromAddress").value || null,
            to_address: document.getElementById("requestToAddress").value || null,
            cargo_type: document.getElementById("requestCargoType").value || null,
            cargo_weight: document.getElementById("requestWeight").value ? parseFloat(document.getElementById("requestWeight").value) : null,
            cargo_volume: document.getElementById("requestVolume").value ? parseFloat(document.getElementById("requestVolume").value) : null,
            body_type: document.getElementById("requestBodyType").value || null,
            loading_date: loadingDate.toISOString(),
            delivery_date: deliveryDate ? deliveryDate.toISOString() : null,
            max_price: maxP,
            min_price: null,
            is_express: document.getElementById("requestIsExpress").checked,
            conditions: document.getElementById("requestConditions").value || null,
            auction_type: "OPEN",
            bidding_started_at: biddingStartedAt ? biddingStartedAt.toISOString() : null,
            bidding_ends_at: biddingEndsAt ? biddingEndsAt.toISOString() : null
        };
        const response = await fetch(`${REQUESTS_API_URL}/requests`, {
            method: "POST",
            headers: getHeaders(),
            body: JSON.stringify(requestData)
        });
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || "Ошибка создания заявки");
        }
        const createdRequest = await response.json();
        if (allRequests) {
            allRequests.unshift(createdRequest);
            let requestsToDisplay = allRequests;
            if (currentSearchQuery.trim()) {
                requestsToDisplay = filterRequestsByQuery(allRequests, currentSearchQuery);
            }
            displayRequests(requestsToDisplay);
        } else {
            loadRequests();
        }
        closeCreateModal();
        if (typeof showSuccess === "function") {
            showSuccess("Заявка успешно создана!");
        }
    } catch (error) {
        console.error("Ошибка создания заявки:", error);
        if (typeof showError === "function") {
            showError(error.message);
        } else {
            if (typeof showError === "function") {
                showError(error.message);
            }
        }
    }
}

function pluralBidOffersRu(n) {
    const v = n % 100;
    const l = n % 10;
    if (v > 10 && v < 20) return "предложений";
    if (l === 1) return "предложение";
    if (l >= 2 && l <= 4) return "предложения";
    return "предложений";
}

let bidModalMarketBids = [];

let bidModalEditingBidId = null;

function parseBidPriceFromInput() {
    const el = document.getElementById("bidPrice");
    if (!el) return NaN;
    const digits = String(el.value).replace(/\D/g, "");
    if (!digits) return NaN;
    return parseInt(digits, 10);
}

function formatBidPriceDisplay(n) {
    if (!Number.isFinite(n) || n < 0) return "";
    return Number(n).toLocaleString("ru-RU");
}

function setBidPriceFieldValue(num) {
    const el = document.getElementById("bidPrice");
    if (!el) return;
    if (num == null || num === "" || !Number.isFinite(Number(num))) {
        el.value = "";
        return;
    }
    el.value = formatBidPriceDisplay(Math.round(Number(num)));
}

function validateBidPriceGrid() {
    const el = document.getElementById("bidPrice");
    if (!el) return;
    const p = parseBidPriceFromInput();
    if (!Number.isFinite(p) || p <= 0) {
        el.classList.remove("bid-modal__price-input--error");
        return;
    }
    el.classList.toggle("bid-modal__price-input--error", !isBidPriceOnGrid(p));
}

function getBidModalComparableBids() {
    let list = Array.isArray(bidModalMarketBids) ? [ ...bidModalMarketBids ] : [];
    if (bidModalEditingBidId) {
        list = list.filter(b => String(b.id) !== String(bidModalEditingBidId));
    }
    return list;
}

function updateBidModalPositionHint() {
    const el = document.getElementById("bidModalPositionHint");
    if (!el) return;
    const price = parseBidPriceFromInput();
    const comps = getBidModalComparableBids();
    const y = comps.length;
    const prices = comps.map(b => Number(b.price)).filter(p => Number.isFinite(p));
    if (!Number.isFinite(price) || price <= 0) {
        el.textContent = "";
        el.hidden = true;
        el.className = "bid-modal__position";
        return;
    }
    if (y === 0) {
        el.textContent = "Пока нет других предложений — вы первые на бирже";
        el.hidden = false;
        el.className = "bid-modal__position bid-modal__position--neutral";
        return;
    }
    const minP = Math.min(...prices);
    const cheaperThanUser = prices.filter(p => p > price).length;
    if (price > minP) {
        el.textContent = `Выше текущей лучшей цены (${Number(minP).toLocaleString("ru-RU")} ₸)`;
        el.hidden = false;
        el.className = "bid-modal__position bid-modal__position--warn";
    } else if (price < minP) {
        el.textContent = `Вы дешевле ${cheaperThanUser} из ${y} ${pluralBidOffersRu(y)}`;
        el.hidden = false;
        el.className = "bid-modal__position bid-modal__position--good";
    } else {
        el.textContent = `На уровне лучшей цены среди ${y} ${pluralBidOffersRu(y)}`;
        el.hidden = false;
        el.className = "bid-modal__position bid-modal__position--neutral";
    }
}

function onBidPriceInput(e) {
    const el = e.target;
    const rawDigits = String(el.value).replace(/\D/g, "");
    if (!rawDigits) {
        el.value = "";
        updateBidModalPricePerKmDisplay();
        updateBidModalPositionHint();
        validateBidPriceGrid();
        return;
    }
    const n = parseInt(rawDigits, 10);
    el.value = formatBidPriceDisplay(n);
    updateBidModalPricePerKmDisplay();
    updateBidModalPositionHint();
    validateBidPriceGrid();
}

function updateBidModalPricePerKmDisplay() {
    const kmHid = document.getElementById("bidContextDistanceKm");
    const out = document.getElementById("bidPricePerKmDisplay");
    const line = document.getElementById("bidPricePerKmLine");
    if (!kmHid || !out) return;
    const price = parseBidPriceFromInput();
    const km = parseFloat(kmHid.value);
    if (!Number.isFinite(price) || !Number.isFinite(km) || km <= 0) {
        out.textContent = "—";
        if (line) line.classList.add("bid-modal__perkm--dim");
        return;
    }
    const per = price / km;
    out.textContent = per.toLocaleString("ru-RU", {
        maximumFractionDigits: 1
    });
    if (line) line.classList.remove("bid-modal__perkm--dim");
}

function onBidDeliveryTimeChange() {
    const sel = document.getElementById("bidDeliveryTime");
    const wrap = document.getElementById("bidDeliveryTimeOtherWrap");
    if (!sel || !wrap) return;
    const show = sel.value === "__other__";
    wrap.hidden = !show;
    if (show) {
        const o = document.getElementById("bidDeliveryTimeOther");
        if (o) o.focus();
    }
}

function mapDeliveryToSelect(val) {
    const sel = document.getElementById("bidDeliveryTime");
    const wrap = document.getElementById("bidDeliveryTimeOtherWrap");
    const other = document.getElementById("bidDeliveryTimeOther");
    if (!sel) return;
    const preset = [ "1 день", "2 дня", "3 дня" ];
    if (!val) {
        sel.value = "";
        if (wrap) wrap.hidden = true;
        if (other) other.value = "";
        return;
    }
    if (preset.includes(val)) {
        sel.value = val;
        if (wrap) wrap.hidden = true;
        if (other) other.value = "";
        return;
    }
    sel.value = "__other__";
    if (other) other.value = val;
    if (wrap) wrap.hidden = false;
}

function getDeliveryTimeValue() {
    const sel = document.getElementById("bidDeliveryTime");
    if (!sel || !sel.value) return null;
    if (sel.value === "__other__") {
        const o = document.getElementById("bidDeliveryTimeOther");
        const t = o && o.value.trim();
        return t || null;
    }
    return sel.value;
}

function composeVehicleInfoString() {
    const body = document.getElementById("bidVehicleBodyType")?.value?.trim() || "";
    const cap = document.getElementById("bidVehicleCapacity")?.value?.trim() || "";
    const brand = document.getElementById("bidVehicleBrand")?.value?.trim() || "";
    const parts = [];
    if (body) parts.push(body);
    if (cap) parts.push(`${cap} т`);
    if (brand) parts.push(brand);
    return parts.length ? parts.join(" · ") : null;
}

function fillVehicleFieldsFromString(s) {
    const bodySel = document.getElementById("bidVehicleBodyType");
    const capEl = document.getElementById("bidVehicleCapacity");
    const brandEl = document.getElementById("bidVehicleBrand");
    if (!bodySel || !capEl || !brandEl) return;
    bodySel.value = "";
    capEl.value = "";
    brandEl.value = "";
    if (!s) return;
    const parts = s.split(" · ").map(p => p.trim()).filter(Boolean);
    const known = [ ...bodySel.options ].map(o => o.value).filter(Boolean);
    if (parts.length === 1) {
        const v = parts[0];
        if (known.includes(v)) bodySel.value = v; else brandEl.value = v;
        return;
    }
    if (parts[0] && known.includes(parts[0])) bodySel.value = parts[0]; else if (parts[0]) brandEl.value = parts[0];
    if (parts[1]) {
        const m = parts[1].match(/^([\d.,]+)\s*т$/i);
        if (m) capEl.value = m[1].replace(",", ".");
    }
    if (parts[2]) brandEl.value = parts[2];
}

async function hydrateBidModalContext(requestId) {
    let req = Array.isArray(allRequests) ? allRequests.find(r => r.id === requestId) : null;
    if (!req) {
        try {
            req = await apiFetch(`${REQUESTS_API_URL}/requests/${requestId}`);
        } catch (e) {
            req = null;
        }
    }
    const routeEl = document.getElementById("bidContextRoute");
    const distEl = document.getElementById("bidContextDistance");
    const dateEl = document.getElementById("bidContextLoadingDate");
    const budgetEl = document.getElementById("bidContextBudget");
    const kmHid = document.getElementById("bidContextDistanceKm");
    const recHint = document.getElementById("bidPriceRecHint");
    if (routeEl) {
        routeEl.textContent = req ? `${req.from_city || "—"} → ${req.to_city || "—"}` : "—";
    }
    if (distEl) {
        distEl.textContent = req && req.distance_km != null ? `${Number(req.distance_km).toLocaleString("ru-RU", {
            maximumFractionDigits: 1
        })} км` : "—";
    }
    if (kmHid) {
        kmHid.value = req && req.distance_km != null ? String(req.distance_km) : "";
    }
    if (dateEl) {
        dateEl.textContent = req && req.loading_date ? `Погрузка: ${new Date(req.loading_date).toLocaleDateString("ru-RU")}` : "Погрузка: —";
    }
    if (budgetEl) {
        budgetEl.textContent = req && req.max_price != null ? `Бюджет: ${Number(req.max_price).toLocaleString("ru-RU")} ₸` : "Бюджет: договорная";
    }
    if (recHint) {
        if (req && req.max_price != null) {
            recHint.textContent = `Ориентир: в рамках бюджета до ${Number(req.max_price).toLocaleString("ru-RU")} ₸`;
            recHint.hidden = false;
        } else {
            recHint.textContent = "";
            recHint.hidden = true;
        }
    }
    let bids = [];
    try {
        bids = await apiFetch(`${REQUESTS_API_URL}/requests/${requestId}/bids`);
    } catch {
        bids = [];
    }
    bidModalMarketBids = Array.isArray(bids) ? bids : [];
    const strip = document.getElementById("bidModalMarketStrip");
    const cntEl = document.getElementById("bidMarketCountText");
    const bestEl = document.getElementById("bidMarketBestPrice");
    if (!strip || !cntEl || !bestEl) return;
    strip.style.display = "flex";
    const n = bidModalMarketBids.length;
    if (n === 0) {
        cntEl.textContent = "Пока нет";
        bestEl.textContent = "—";
        bestEl.classList.remove("bid-modal__market-best--hot");
        return;
    }
    cntEl.textContent = `${n} ${pluralBidOffersRu(n)}`;
    const prices = bidModalMarketBids.map(b => b.price).filter(p => p != null && !Number.isNaN(Number(p)));
    const best = prices.length ? Math.min(...prices.map(Number)) : null;
    if (best != null) {
        bestEl.textContent = `${Number(best).toLocaleString("ru-RU")} ₸`;
        bestEl.classList.add("bid-modal__market-best--hot");
    } else {
        bestEl.textContent = "—";
        bestEl.classList.remove("bid-modal__market-best--hot");
    }
}

function initBidModalForm() {
    const form = document.getElementById("bidForm");
    if (!form || form.dataset.bidModalBound === "1") return;
    form.dataset.bidModalBound = "1";
    const price = document.getElementById("bidPrice");
    const delivery = document.getElementById("bidDeliveryTime");
    if (price) {
        price.addEventListener("input", onBidPriceInput);
        price.addEventListener("blur", validateBidPriceGrid);
    }
    if (delivery) {
        delivery.addEventListener("change", onBidDeliveryTimeChange);
    }
}

async function openBidModal(requestId) {
    const modalTitle = document.getElementById("bidModalTitle");
    const submitBtn = document.getElementById("bidSubmitBtn");
    if (modalTitle) modalTitle.textContent = "Сделать ставку";
    if (submitBtn) submitBtn.textContent = "Сделать ставку";
    document.getElementById("bidForm").reset();
    document.getElementById("bidRequestId").value = requestId;
    document.getElementById("bidId").value = "";
    const otherWrap = document.getElementById("bidDeliveryTimeOtherWrap");
    if (otherWrap) otherWrap.hidden = true;
    const recHint = document.getElementById("bidPriceRecHint");
    if (recHint) recHint.hidden = true;
    bidModalEditingBidId = null;
    await hydrateBidModalContext(requestId);
    document.getElementById("bidModal").style.display = "flex";
    lockBodyScroll();
    updateBidModalPricePerKmDisplay();
    updateBidModalPositionHint();
    requestAnimationFrame(() => {
        const p = document.getElementById("bidPrice");
        if (p) {
            p.focus();
            try {
                p.setSelectionRange(p.value.length, p.value.length);
            } catch {}
        }
    });
}

async function editBid(bidId, requestId) {
    try {
        const modalTitle = document.getElementById("bidModalTitle");
        const submitBtn = document.getElementById("bidSubmitBtn");
        if (modalTitle) modalTitle.textContent = "Изменить ставку";
        if (submitBtn) submitBtn.textContent = "Сохранить изменения";
        document.getElementById("bidForm").reset();
        document.getElementById("bidRequestId").value = requestId;
        document.getElementById("bidId").value = bidId;
        const otherWrap = document.getElementById("bidDeliveryTimeOtherWrap");
        if (otherWrap) otherWrap.hidden = true;
        bidModalEditingBidId = String(bidId);
        await hydrateBidModalContext(requestId);
        const response = await fetch(`${REQUESTS_API_URL}/requests/${requestId}/bids`, {
            headers: getHeaders()
        });
        if (!response.ok) {
            throw new Error("Ошибка загрузки ставок");
        }
        const bids = await response.json();
        const bid = bids.find(b => b.id === bidId);
        if (!bid) {
            throw new Error("Ставка не найдена");
        }
        setBidPriceFieldValue(bid.price);
        mapDeliveryToSelect(bid.delivery_time || "");
        fillVehicleFieldsFromString(bid.vehicle_info || "");
        document.getElementById("bidConditions").value = bid.conditions || "";
        document.getElementById("bidModal").style.display = "flex";
        lockBodyScroll();
        updateBidModalPricePerKmDisplay();
        updateBidModalPositionHint();
        validateBidPriceGrid();
        requestAnimationFrame(() => {
            const p = document.getElementById("bidPrice");
            if (p) {
                p.focus();
                try {
                    p.setSelectionRange(p.value.length, p.value.length);
                } catch {}
            }
        });
    } catch (error) {
        console.error("Ошибка загрузки ставки:", error);
        if (typeof showError === "function") {
            showError(error.message);
        }
    }
}

function closeBidModal() {
    document.getElementById("bidModal").style.display = "none";
    document.getElementById("bidForm").reset();
    const bidIdField = document.getElementById("bidId");
    if (bidIdField) bidIdField.value = "";
    bidModalMarketBids = [];
    bidModalEditingBidId = null;
    const priceEl = document.getElementById("bidPrice");
    if (priceEl) priceEl.classList.remove("bid-modal__price-input--error");
    const pos = document.getElementById("bidModalPositionHint");
    if (pos) {
        pos.textContent = "";
        pos.hidden = true;
    }
    const otherWrap = document.getElementById("bidDeliveryTimeOtherWrap");
    if (otherWrap) otherWrap.hidden = true;
    unlockBodyScroll();
}

async function submitBid(event2) {
    event2.preventDefault();
    try {
        const user = loadUserData();
        if (!user) {
            if (typeof showWarning === "function") {
                showWarning("Необходимо авторизоваться");
            }
            return;
        }
        const requestId = parseInt(document.getElementById("bidRequestId").value, 10);
        const bidIdField = document.getElementById("bidId");
        const bidId = bidIdField ? bidIdField.value : "";
        const isEdit = bidId && bidId !== "";
        const priceRaw = parseBidPriceFromInput();
        if (!Number.isFinite(priceRaw) || priceRaw <= 0) {
            throw new Error("Укажите сумму");
        }
        if (!isBidPriceOnGrid(priceRaw)) {
            validateBidPriceGrid();
            throw new Error(`Сумма должна быть кратна ${BID_PRICE_GRID_TENGE.toLocaleString("ru-RU")} ₸`);
        }
        const delSel = document.getElementById("bidDeliveryTime");
        if (delSel && delSel.value === "__other__") {
            const o = document.getElementById("bidDeliveryTimeOther");
            if (!o || !o.value.trim()) {
                throw new Error("Укажите срок доставки");
            }
        }
        const km = parseFloat(document.getElementById("bidContextDistanceKm").value);
        let pricePerKm = null;
        if (Number.isFinite(km) && km > 0 && Number.isFinite(priceRaw) && priceRaw > 0) {
            pricePerKm = Math.round(priceRaw / km * 100) / 100;
        }
        const bidData = {
            price: priceRaw,
            price_per_km: pricePerKm,
            delivery_time: getDeliveryTimeValue(),
            vehicle_info: composeVehicleInfoString(),
            conditions: document.getElementById("bidConditions").value.trim() || null
        };
        let response;
        if (isEdit) {
            response = await fetch(`${REQUESTS_API_URL}/bids/${bidId}`, {
                method: "PUT",
                headers: getHeaders(),
                body: JSON.stringify(bidData)
            });
        } else {
            response = await fetch(`${REQUESTS_API_URL}/requests/${requestId}/bids`, {
                method: "POST",
                headers: getHeaders(),
                body: JSON.stringify(bidData)
            });
        }
        if (!response.ok) {
            const errBody = await response.json().catch(() => ({}));
            throw new Error(errBody.detail || `Ошибка ${isEdit ? "обновления" : "отправки"} ставки`);
        }
        closeBidModal();
        if (typeof showSuccess === "function") {
            showSuccess(isEdit ? "Ставка обновлена" : "Ставка отправлена");
        }
        if (currentRequestDetail && currentRequestDetail.id === requestId) {
            await refetchCurrentRequestDetail(requestId, {
                refreshList: true,
                reloadHistory: false,
                reloadContract: false
            });
            tabLoadState.bids = false;
            await loadBidsForDetail();
        } else {
            await loadRequests(true);
        }
    } catch (error) {
        console.error("Ошибка отправки ставки:", error);
        if (typeof showError === "function") {
            showError(error.message);
        }
    }
}

async function viewBids(requestId) {
    try {
        const response = await fetch(`${REQUESTS_API_URL}/requests/${requestId}/bids`);
        if (!response.ok) {
            throw new Error("Ошибка загрузки предложений");
        }
        const bids = await response.json();
        if (bids.length === 0) {
            if (typeof showInfo === "function") {
                showInfo("Пока нет предложений на эту заявку");
            }
            return;
        }
        currentSelectWinnerRequestId = requestId;
        currentSelectWinnerBids = bids;
        resetWinnerPickerModalPanels();
        displayBidsForSelection(bids);
        document.getElementById("selectWinnerModal").style.display = "flex";
        lockBodyScroll();
    } catch (error) {
        console.error("Ошибка:", error);
        if (typeof showError === "function") {
            showError(error.message);
        } else {
            if (typeof showError === "function") {
                showError(error.message);
            }
        }
    }
}

let currentSelectWinnerRequestId = null;

let currentSelectWinnerBids = [];

let winnerPickerSelectedBidId = null;

function applyWinnerPickerSelectionHighlight(bidId) {
    const rows = document.querySelectorAll("#bidsSelectionList .bid-selection-row");
    rows.forEach(el => {
        const id = parseInt(el.getAttribute("data-bid-id"), 10);
        el.classList.toggle("bid-selection-row--selected", bidId != null && id === bidId);
        el.setAttribute("aria-pressed", bidId != null && id === bidId ? "true" : "false");
    });
    const btn = document.getElementById("btnConfirmWinner");
    if (btn) btn.disabled = !(bidId != null && !Number.isNaN(Number(bidId)));
}

function displayBidsForSelection(bids) {
    const bidsList = document.getElementById("bidsSelectionList");
    if (!bidsList) return;
    const sortedBids = [ ...bids ].sort((a, b) => a.price - b.price);
    bidsList.innerHTML = sortedBids.map((bid, index) => {
        const bidTime = new Date(bid.created_at).toLocaleString("ru-RU");
        const isBestPrice = index === 0;
        const cid = bid.carrier_id != null && bid.carrier_id !== "" ? String(parseInt(String(bid.carrier_id), 10) || "") : "";
        const cname = escapeHtmlAttr(bid.carrier_name || bid.carrier_company || "Перевозчик");
        const nameLabel = escapeHtmlBid(bid.carrier_name || bid.carrier_company || "Перевозчик");
        const perKm = bid.price_per_km ? `<div class="bid-selection-row__perkm">${bid.price_per_km.toLocaleString("ru-RU")} <span class="bid-selection-row__perkm-unit">₸/км</span></div>` : "";
        const del = bid.delivery_time ? `<div class="bid-selection-row__detail"><span class="bid-selection-row__lbl">Срок</span> ${escapeHtmlBid(bid.delivery_time)}</div>` : "";
        const veh = bid.vehicle_info ? `<div class="bid-selection-row__detail"><span class="bid-selection-row__lbl">Транспорт</span> ${escapeHtmlBid(bid.vehicle_info)}</div>` : "";
        return `\n      <div class="bid-selection-row ${isBestPrice ? "bid-selection-row--lead" : ""}" data-bid-id="${bid.id}" role="button" tabindex="0" aria-pressed="false" aria-label="Выбрать: ${nameLabel}, ${bid.price.toLocaleString("ru-RU")} ₸">\n        <div class="bid-selection-row__top">\n          ${isBestPrice ? '<span class="bid-selection-row__tag">Лучшая цена</span>' : `<span class="bid-selection-row__rank">#${index + 1}</span>`}\n        </div>\n        <div class="bid-selection-row__carrier">${nameLabel}</div>\n        <div class="bid-selection-row__price">${bid.price.toLocaleString("ru-RU")} <span class="bid-selection-row__currency">₸</span></div>\n        ${perKm}\n        ${del}\n        ${veh}\n        <div class="bid-selection-row__time"><span class="bid-selection-row__lbl">Подано</span> ${escapeHtmlBid(bidTime)}</div>\n        <button type="button" class="bid-selection-row__carrier-link js-winner-carrier-info" data-carrier-id="${cid}" data-carrier-name="${cname}" data-bid-id="${bid.id}">Подробнее о перевозчике</button>\n      </div>\n    `;
    }).join("");
    winnerPickerSelectedBidId = null;
    applyWinnerPickerSelectionHighlight(null);
}

const WINNER_MODAL_DEFAULT_TITLE = "Выберите перевозчика";

const WINNER_MODAL_DEFAULT_SUBTITLE = "Сравните цены и условия, при необходимости откройте карточку. Затем подтвердите выбор одной кнопкой.";

function resetWinnerPickerModalPanels() {
    winnerPickerSelectedBidId = null;
    const bidsPanel = document.getElementById("winnerBidsPanel");
    const carrierPanel = document.getElementById("carrierWinnerDetailPanel");
    const footer = document.getElementById("winnerPickerFooter");
    const backBtn = document.getElementById("winnerModalBackBtn");
    const title = document.getElementById("selectWinnerModalTitle");
    const subtitle = document.getElementById("selectWinnerModalSubtitle");
    const carrierInner = document.getElementById("carrierWinnerDetailContent");
    if (bidsPanel) bidsPanel.style.display = "";
    if (carrierPanel) carrierPanel.style.display = "none";
    if (footer) footer.style.display = "";
    if (backBtn) backBtn.style.display = "none";
    if (title) title.textContent = WINNER_MODAL_DEFAULT_TITLE;
    if (subtitle) {
        subtitle.textContent = WINNER_MODAL_DEFAULT_SUBTITLE;
        subtitle.classList.remove("modal-winner-pick__subtitle--quiet");
    }
    if (carrierInner) carrierInner.innerHTML = "";
    const btn = document.getElementById("btnConfirmWinner");
    if (btn) btn.disabled = true;
}

function backFromCarrierInWinnerModal() {
    const bidsPanel = document.getElementById("winnerBidsPanel");
    const carrierPanel = document.getElementById("carrierWinnerDetailPanel");
    const footer = document.getElementById("winnerPickerFooter");
    const backBtn = document.getElementById("winnerModalBackBtn");
    const title = document.getElementById("selectWinnerModalTitle");
    const subtitle = document.getElementById("selectWinnerModalSubtitle");
    const carrierInner = document.getElementById("carrierWinnerDetailContent");
    if (bidsPanel) bidsPanel.style.display = "";
    if (carrierPanel) carrierPanel.style.display = "none";
    if (footer) footer.style.display = "";
    if (backBtn) backBtn.style.display = "none";
    if (title) title.textContent = WINNER_MODAL_DEFAULT_TITLE;
    if (subtitle) {
        subtitle.textContent = WINNER_MODAL_DEFAULT_SUBTITLE;
        subtitle.classList.remove("modal-winner-pick__subtitle--quiet");
    }
    if (carrierInner) carrierInner.innerHTML = "";
    currentCarrierInfoId = null;
    applyWinnerPickerSelectionHighlight(winnerPickerSelectedBidId);
}

async function confirmWinnerPickerSelection() {
    if (!currentSelectWinnerRequestId || !winnerPickerSelectedBidId) return;
    await selectWinner(currentSelectWinnerRequestId, winnerPickerSelectedBidId);
}

function closeSelectWinnerModal() {
    resetWinnerPickerModalPanels();
    const modal = document.getElementById("selectWinnerModal");
    if (modal) {
        modal.style.display = "none";
        unlockBodyScroll();
    }
    currentSelectWinnerRequestId = null;
    currentSelectWinnerBids = [];
    winnerPickerSelectedBidId = null;
}

function onBidsSelectionListClick(e) {
    const bidsSelectionList = document.getElementById("bidsSelectionList");
    if (!bidsSelectionList) return;
    const carrierBtn = e.target.closest(".js-winner-carrier-info");
    if (carrierBtn) {
        e.preventDefault();
        e.stopPropagation();
        const bidFromBtn = parseInt(carrierBtn.getAttribute("data-bid-id"), 10);
        if (bidFromBtn && !Number.isNaN(bidFromBtn)) {
            winnerPickerSelectedBidId = bidFromBtn;
            applyWinnerPickerSelectionHighlight(bidFromBtn);
        }
        const id = parseInt(carrierBtn.getAttribute("data-carrier-id"), 10);
        const nameAttr = carrierBtn.getAttribute("data-carrier-name");
        const name = nameAttr != null && nameAttr !== "" ? nameAttr : "Перевозчик";
        if (!id || Number.isNaN(id)) {
            if (typeof showWarning === "function") {
                showWarning("Не удалось открыть карточку: нет данных перевозчика.");
            }
            return;
        }
        viewCarrierInfo(id, name, {
            fromWinnerPicker: true
        });
        return;
    }
    const row = e.target.closest(".bid-selection-row");
    if (row && bidsSelectionList.contains(row)) {
        const bidId = parseInt(row.getAttribute("data-bid-id"), 10);
        if (bidId && !Number.isNaN(bidId)) {
            winnerPickerSelectedBidId = bidId;
            applyWinnerPickerSelectionHighlight(bidId);
        }
    }
}

function onBidsSelectionListKeydown(e) {
    const bidsSelectionList = document.getElementById("bidsSelectionList");
    if (!bidsSelectionList || e.key !== "Enter" && e.key !== " ") return;
    const row = e.target.closest(".bid-selection-row");
    if (!row || !bidsSelectionList.contains(row)) return;
    if (e.target.closest(".js-winner-carrier-info")) return;
    e.preventDefault();
    const bidId = parseInt(row.getAttribute("data-bid-id"), 10);
    if (bidId && !Number.isNaN(bidId)) {
        winnerPickerSelectedBidId = bidId;
        applyWinnerPickerSelectionHighlight(bidId);
    }
}

function initWinnerModalListeners() {
    const bidsSelectionList = document.getElementById("bidsSelectionList");
    if (bidsSelectionList && !bidsSelectionList.dataset.boundWinnerClicks) {
        bidsSelectionList.dataset.boundWinnerClicks = "1";
        bidsSelectionList.addEventListener("click", onBidsSelectionListClick);
        bidsSelectionList.addEventListener("keydown", onBidsSelectionListKeydown);
    }
    const selectWinnerModal = document.getElementById("selectWinnerModal");
    if (selectWinnerModal && !selectWinnerModal.dataset.boundBackdrop) {
        selectWinnerModal.dataset.boundBackdrop = "1";
        selectWinnerModal.addEventListener("click", e => {
            if (e.target === selectWinnerModal) {
                closeSelectWinnerModal();
            }
        });
    }
    const carrierInfoModal = document.getElementById("carrierInfoModal");
    if (carrierInfoModal && !carrierInfoModal.dataset.boundBackdrop) {
        carrierInfoModal.dataset.boundBackdrop = "1";
        carrierInfoModal.addEventListener("click", e => {
            if (e.target === carrierInfoModal) {
                closeCarrierInfoModal();
            }
        });
    }
}

async function autoSelectWinner() {
    if (!currentSelectWinnerRequestId) return;
    try {
        await selectWinner(currentSelectWinnerRequestId, "auto");
        closeSelectWinnerModal();
    } catch (error) {
        console.error("Ошибка:", error);
        if (typeof showError === "function") {
            showError(error.message);
        } else {
            if (typeof showError === "function") {
                showError(error.message);
            }
        }
    }
}

async function showConfirm(message, title = "Подтверждение", confirmText = "ОК", cancelText = "Отмена", confirmColor = "#2563eb") {
    return new Promise(resolve => {
        let confirmed = false;
        const modal = document.createElement("div");
        modal.className = "confirm-modal";
        modal.style.cssText = `\n    position: fixed;\n    top: 0;\n    left: 0;\n    right: 0;\n    bottom: 0;\n    background: rgba(0, 0, 0, 0.5);\n    display: flex;\n    align-items: center;\n    justify-content: center;\n    z-index: 10000;\n  `;
        modal.innerHTML = `\n      <div style="background: white; padding: 24px; border-radius: 12px; max-width: 500px; width: 90%; box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);">\n        <h3 style="margin: 0 0 16px 0; font-size: 18px; font-weight: 600; color: #1a1a1a;">${title}</h3>\n        <p style="margin: 0 0 24px 0; color: #6b7280; line-height: 1.5; white-space: pre-line;">${message}</p>\n      <div style="display: flex; gap: 12px; justify-content: flex-end;">\n          <button id="confirmCancel" style="padding: 10px 20px; border: 1px solid #e5e7eb; background: white; border-radius: 8px; cursor: pointer; font-weight: 500; transition: all 0.2s;">${cancelText}</button>\n          <button id="confirmOk" style="padding: 10px 20px; background: ${confirmColor}; color: white; border: none; border-radius: 8px; cursor: pointer; font-weight: 500; transition: all 0.2s;">${confirmText}</button>\n      </div>\n    </div>\n  `;
        document.body.appendChild(modal);
        const cancelBtn = modal.querySelector("#confirmCancel");
        const okBtn = modal.querySelector("#confirmOk");
        cancelBtn.addEventListener("mouseenter", () => {
            cancelBtn.style.background = "#f3f4f6";
        });
        cancelBtn.addEventListener("mouseleave", () => {
            cancelBtn.style.background = "white";
        });
        okBtn.addEventListener("mouseenter", () => {
            okBtn.style.opacity = "0.9";
        });
        okBtn.addEventListener("mouseleave", () => {
            okBtn.style.opacity = "1";
        });
        okBtn.addEventListener("click", () => {
            confirmed = true;
            document.body.removeChild(modal);
            resolve(true);
        });
        cancelBtn.addEventListener("click", () => {
            document.body.removeChild(modal);
            resolve(false);
        });
        modal.addEventListener("click", e => {
            if (e.target === modal) {
                document.body.removeChild(modal);
                resolve(false);
            }
        });
    });
}

async function deleteRequest(requestId) {
    const confirmed = await showConfirm("Вы уверены, что хотите удалить эту заявку?", "Подтверждение удаления", "Удалить", "Отмена", "#ef4444");
    if (!confirmed) {
        return;
    }
    try {
        const response = await fetch(`${REQUESTS_API_URL}/requests/${requestId}`, {
            method: "DELETE",
            headers: getHeaders()
        });
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || "Ошибка удаления заявки");
        }
        invalidateRequestCache(requestId);
        if (allRequests) {
            allRequests = allRequests.filter(r => r.id !== requestId);
            let requestsToDisplay = allRequests;
            if (currentSearchQuery.trim()) {
                requestsToDisplay = filterRequestsByQuery(allRequests, currentSearchQuery);
            }
            displayRequests(requestsToDisplay);
        } else {
            loadRequests();
        }
        if (typeof showSuccess === "function") {
            showSuccess("Заявка успешно удалена");
        }
    } catch (error) {
        console.error("Ошибка удаления заявки:", error);
        if (typeof showError === "function") {
            showError(error.message);
        } else {
            if (typeof showError === "function") {
                showError(error.message);
            }
        }
    }
}

let currentCarrierInfoId = null;

const CARRIER_INFO_LOADING_HTML = `\n    <div class="empty">\n      <div class="empty-icon"></div>\n      <div class="empty-title">Загрузка информации...</div>\n    </div>\n  `;

async function loadCarrierDetailAndStats(carrierId) {
    const carrier = await apiFetch(`${API_URL}/api/users/${carrierId}`);
    let stats = null;
    try {
        stats = await apiFetch(`${API_URL}/api/requests/carriers/${carrierId}/stats?_t=${Date.now()}`);
        debugLog("[viewCarrierInfo] Статистика перевозчика:", stats);
    } catch (err) {
        console.error("Ошибка загрузки статистики перевозчика:", err);
        stats = {
            completed_requests: 0,
            active_requests: 0,
            total_requests: 0,
            rating: 0,
            reviews_count: 0,
            registered_at: carrier.created_at || null
        };
    }
    return {
        carrier: carrier,
        stats: stats
    };
}

function carrierProfileDisplayName(carrier, carrierName) {
    const company = (carrier.company_name || "").trim();
    const full = (carrier.full_name || "").trim();
    if (company) return company;
    if (full) return full;
    return carrierName || "Перевозчик";
}

function carrierProfileInitials(displayName) {
    const s = String(displayName || "П").trim();
    const parts = s.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return s.slice(0, 2).toUpperCase() || "П";
}

function maskCarrierIin(iin) {
    if (!iin || String(iin).trim().length < 4) return "—";
    const t = String(iin).replace(/\s/g, "");
    return "****" + t.slice(-4);
}

function maskCarrierEmail(email) {
    if (!email || !String(email).includes("@")) return "не указан";
    const [u, d] = String(email).split("@");
    if (!d) return "не указан";
    const um = u.length <= 2 ? "*" : u[0] + "***" + u.slice(-1);
    return `${um}@${d}`;
}

function maskCarrierPhoneShort(phone) {
    if (!phone) return "";
    const d = String(phone).replace(/\D/g, "");
    if (d.length < 4) return "+* *** ***";
    return "+* *** ***-**-" + d.slice(-2);
}

function carrierProfileStarsHtml(rating) {
    const r = Math.max(0, Math.min(5, Number(rating) || 0));
    const full = Math.floor(r);
    const half = r - full >= .5;
    let html = "";
    for (let i = 1; i <= 5; i++) {
        if (i <= full) {
            html += '<span class="carrier-profile-star carrier-profile-star--on" aria-hidden="true">★</span>';
        } else if (i === full + 1 && half) {
            html += '<span class="carrier-profile-star carrier-profile-star--half" aria-hidden="true">★</span>';
        } else {
            html += '<span class="carrier-profile-star" aria-hidden="true">☆</span>';
        }
    }
    return html;
}

function buildCarrierReviewsSection(stats) {
    const sample = Array.isArray(stats.reviews) ? stats.reviews.slice(0, 3) : [];
    if (sample.length > 0) {
        return sample.map(rev => {
            const rr = Math.max(0, Math.min(5, Number(rev.rating) || 0));
            const text = escapeHtmlBid(rev.text || rev.comment || "");
            const who = escapeHtmlBid(rev.author || rev.from || "Заказчик");
            return `\n          <div class="carrier-profile-review-card">\n            <div class="carrier-profile-review-card__head">\n              <span class="carrier-profile-review-card__stars">${carrierProfileStarsHtml(rr)}</span>\n              <span class="carrier-profile-review-card__num">${rr.toFixed(1)}</span>\n            </div>\n            <p class="carrier-profile-review-card__text">${text}</p>\n            <p class="carrier-profile-review-card__who">${who}</p>\n          </div>`;
        }).join("");
    }
    if ((stats.reviews_count || 0) > 0 && sample.length === 0) {
        return `\n      <p class="carrier-profile-muted">Отзывы появятся здесь после подключения ленты отзывов (${stats.reviews_count} ожидается).</p>`;
    }
    return `\n    <div class="carrier-profile-reviews-empty">\n      <p class="carrier-profile-reviews-empty__title">Пока нет отзывов</p>\n      <p class="carrier-profile-reviews-empty__sub">Вы можете стать первым</p>\n    </div>`;
}

function buildCarrierProfileFooter(options) {
    if (options && options.fromWinnerPicker) {
        return "";
    }
    return `\n    <div class="carrier-profile-actions carrier-profile-actions--single">\n      <button type="button" class="carrier-profile-btn-back carrier-profile-btn-back--wide" onclick="closeCarrierInfoModal()">Назад</button>\n    </div>`;
}

function buildCarrierInfoHtml(carrier, stats, carrierName, options = {}) {
    const displayName = carrierProfileDisplayName(carrier, carrierName);
    const initials = carrierProfileInitials(displayName);
    const rating = typeof stats.rating === "number" ? stats.rating : Number(stats.rating) || 0;
    const completed = stats.completed_requests || 0;
    const total = stats.total_requests || 0;
    const regRaw = stats.registered_at || carrier.created_at;
    const regYear = regRaw ? new Date(regRaw).getFullYear() : null;
    const successPct = total > 0 ? (completed / total * 100).toFixed(0) : "0";
    let statusLabel = "Новый перевозчик";
    if (total > 0) {
        if (completed >= 5) statusLabel = "Проверен"; else statusLabel = "Надёжный";
    }
    const heroMetaLine = `<p class="carrier-profile-hero-line" title="Рейтинг и активность"><span class="carrier-profile-hero-line__star" aria-hidden="true">★</span> <span class="carrier-profile-hero-line__rating">${rating.toFixed(1)}</span> <span class="carrier-profile-hero-line__dot">•</span> ${escapeHtmlBid(statusLabel)} <span class="carrier-profile-hero-line__dot">•</span> ${completed} перевозок</p>`;
    const trustPart1 = completed === 0 ? "Без выполненных заказов" : `${completed} выполненных перевозок`;
    const trustLine = `${trustPart1} • На платформе с ${regYear || "—"} • Успешность: ${successPct}%`;
    const phoneRaw = carrier.phone && String(carrier.phone).trim();
    const phoneMasked = phoneRaw ? maskCarrierPhoneShort(phoneRaw) : "";
    const fromPicker = !!(options && options.fromWinnerPicker);
    const phoneBlock = phoneRaw ? `<div class="carrier-profile-phone" data-phone-full="${escapeHtmlAttr(phoneRaw)}">\n        <span class="carrier-profile-k">Телефон</span>\n        <span class="carrier-profile-phone-value">${escapeHtmlBid(phoneMasked)}</span>\n        <button type="button" class="carrier-profile-link-btn js-carrier-show-phone">Показать телефон</button>\n      </div>` : `<div class="carrier-profile-line carrier-profile-line--phone"><span class="carrier-profile-k">Телефон</span><span class="carrier-profile-v carrier-profile-v--soft">—</span></div>${fromPicker ? '<p class="carrier-profile-contact-hint">Контакты появятся после выбора исполнителя</p>' : ""}`;
    const emailDisp = carrier.email && String(carrier.email).trim() ? maskCarrierEmail(carrier.email) : "не указан";
    const iinDisp = maskCarrierIin(carrier.iin);
    const aboutSection = completed === 0 ? `\n      <section class="carrier-profile-section carrier-profile-section--tight">\n        <h4 class="carrier-profile-h">О перевозчике</h4>\n        <div class="carrier-profile-about-empty">\n          <p class="carrier-profile-about-empty__text">Пока нет выполненных перевозок</p>\n        </div>\n      </section>` : "";
    return `\n    <div class="carrier-profile">\n      <header class="carrier-profile-hero">\n        <div class="carrier-profile-avatar" aria-hidden="true">${escapeHtmlBid(initials)}</div>\n        <div class="carrier-profile-hero-text">\n          <h3 class="carrier-profile-name">${escapeHtmlBid(displayName)}</h3>\n          ${heroMetaLine}\n        </div>\n      </header>\n\n      <section class="carrier-profile-trust" aria-label="Кратко о надёжности">\n        <p class="carrier-profile-trust__line">${escapeHtmlBid(trustLine)}</p>\n      </section>\n\n      <section class="carrier-profile-section carrier-profile-section--tight">\n        <h4 class="carrier-profile-h">Контакты</h4>\n        ${phoneBlock}\n        <div class="carrier-profile-line">\n          <span class="carrier-profile-k">Email</span>\n          <span class="carrier-profile-v">${escapeHtmlBid(emailDisp)}</span>\n        </div>\n        <div class="carrier-profile-line carrier-profile-line--iin">\n          <span class="carrier-profile-k">ИИН</span>\n          <span class="carrier-profile-iin">${escapeHtmlBid(iinDisp)}</span>\n        </div>\n      </section>\n\n      ${aboutSection}\n\n      <section class="carrier-profile-section carrier-profile-section--tight">\n        <h4 class="carrier-profile-h">Отзывы</h4>\n        <div class="carrier-profile-reviews">${buildCarrierReviewsSection(stats)}</div>\n      </section>\n\n      ${buildCarrierProfileFooter(options)}\n    </div>\n  `;
}

function initCarrierProfilePhoneReveal() {
    if (document.body.dataset.carrierPhoneRevealBound) return;
    document.body.dataset.carrierPhoneRevealBound = "1";
    document.body.addEventListener("click", e => {
        const btn = e.target.closest(".js-carrier-show-phone");
        if (!btn) return;
        e.preventDefault();
        const wrap = btn.closest(".carrier-profile-phone");
        if (!wrap) return;
        const full = wrap.getAttribute("data-phone-full");
        const val = wrap.querySelector(".carrier-profile-phone-value");
        if (val && full) {
            val.textContent = full;
            btn.remove();
        }
    });
}

function showWinnerPickerCarrierMode(carrierName) {
    const bidsPanel = document.getElementById("winnerBidsPanel");
    const carrierPanel = document.getElementById("carrierWinnerDetailPanel");
    const backBtn = document.getElementById("winnerModalBackBtn");
    const title = document.getElementById("selectWinnerModalTitle");
    const subtitle = document.getElementById("selectWinnerModalSubtitle");
    if (bidsPanel) bidsPanel.style.display = "none";
    if (carrierPanel) carrierPanel.style.display = "block";
    if (backBtn) backBtn.style.display = "inline-flex";
    if (title) title.textContent = carrierName || "Перевозчик";
    if (subtitle) {
        subtitle.textContent = "Профиль исполнителя";
        subtitle.classList.add("modal-winner-pick__subtitle--quiet");
    }
}

async function viewCarrierInfo(carrierId, carrierName, options = {}) {
    const fromWinnerPicker = options && options.fromWinnerPicker === true;
    currentCarrierInfoId = carrierId;
    const contentInline = document.getElementById("carrierWinnerDetailContent");
    const modal = document.getElementById("carrierInfoModal");
    const contentStandalone = document.getElementById("carrierInfoContent");
    let content = null;
    if (fromWinnerPicker) {
        if (!contentInline) return;
        content = contentInline;
        showWinnerPickerCarrierMode(carrierName);
    } else {
        if (!modal || !contentStandalone) return;
        content = contentStandalone;
        modal.style.display = "flex";
        lockBodyScroll();
    }
    content.innerHTML = CARRIER_INFO_LOADING_HTML;
    try {
        const {carrier: carrier, stats: stats} = await loadCarrierDetailAndStats(carrierId);
        content.innerHTML = buildCarrierInfoHtml(carrier, stats, carrierName, {
            fromWinnerPicker: fromWinnerPicker
        });
    } catch (error) {
        console.error("Ошибка загрузки информации о перевозчике:", error);
        content.innerHTML = `\n      <div class="empty">\n        <div class="empty-icon"></div>\n        <div class="empty-title">Ошибка загрузки</div>\n        <div class="empty-text">${escapeHtmlBid(error.message || String(error))}</div>\n      </div>\n    `;
    }
}

function closeCarrierInfoModal() {
    const modal = document.getElementById("carrierInfoModal");
    if (modal) {
        modal.style.display = "none";
        unlockBodyScroll();
    }
    currentCarrierInfoId = null;
}

async function selectWinner(requestId, bidId = "auto") {
    try {
        const url = bidId === "auto" ? `${REQUESTS_API_URL}/requests/${requestId}/auto-select` : `${REQUESTS_API_URL}/requests/${requestId}/select-winner?bid_id=${bidId}`;
        const response = await fetch(url, {
            method: "POST",
            headers: getHeaders()
        });
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || "Ошибка выбора победителя");
        }
        closeSelectWinnerModal();
        if (currentRequestDetail && currentRequestDetail.id === requestId) {
            await refetchCurrentRequestDetail(requestId, {
                refreshList: true,
                reloadHistory: true,
                reloadContract: !!currentRequestDetail.contract_created_at
            });
            tabLoadState.bids = false;
            await loadBidsForDetail();
        } else {
            invalidateRequestCache(requestId);
            await loadRequests(true);
        }
        if (typeof showSuccess === "function") {
            showSuccess('Победитель выбран! Заявка переведена в статус "В работе".');
        }
    } catch (error) {
        console.error("Ошибка:", error);
        if (typeof showError === "function") {
            showError(error.message);
        } else {
            if (typeof showError === "function") {
                showError(error.message);
            }
        }
    }
}

function _carrierConfirmRequestId(requestId) {
    const id = requestId != null && requestId !== "" ? Number(requestId) : currentRequestDetail && currentRequestDetail.id;
    if (!id || Number.isNaN(id)) return null;
    return id;
}

async function carrierAcceptRequest(requestId) {
    const id = _carrierConfirmRequestId(requestId);
    if (!id) {
        if (typeof showError === "function") showError("Не указана заявка");
        return;
    }
    try {
        const response = await fetch(`${REQUESTS_API_URL}/requests/${id}/accept`, {
            method: "POST",
            headers: getHeaders()
        });
        if (!response.ok) {
            let msg = "Не удалось подтвердить заказ";
            try {
                const err = await response.json();
                if (err.detail) msg = typeof err.detail === "string" ? err.detail : JSON.stringify(err.detail);
            } catch (_) {}
            throw new Error(msg);
        }
        if (currentRequestDetail && currentRequestDetail.id === id) {
            await refetchCurrentRequestDetail(id, {
                refreshList: true,
                reloadHistory: true,
                reloadContract: !!currentRequestDetail.contract_created_at
            });
            tabLoadState.carrier = false;
            [ "detailCarrierName", "detailCarrierINN", "detailCarrierPhone" ].forEach(hid => {
                const el = document.getElementById(hid);
                if (el) delete el.dataset.loaded;
            });
            await loadCarrierInfo(currentRequestDetail);
            switchTab("carrier");
        } else {
            invalidateRequestCache(id);
            await loadRequests(true);
        }
        if (typeof showSuccess === "function") {
            showSuccess("Заказ подтверждён. Дальше — назначьте водителя и машину во вкладке «Перевозчик».");
        }
    } catch (e) {
        debugError(e);
        if (typeof showError === "function") showError(e.message || String(e));
    }
}

async function carrierDeclineRequest(requestId) {
    const id = _carrierConfirmRequestId(requestId);
    if (!id) {
        if (typeof showError === "function") showError("Не указана заявка");
        return;
    }
    if (!window.confirm("Отказаться от этого заказа? Заявка снова станет активной, заказчик сможет выбрать другого перевозчика.")) {
        return;
    }
    try {
        const response = await fetch(`${REQUESTS_API_URL}/requests/${id}/decline`, {
            method: "POST",
            headers: getHeaders()
        });
        if (!response.ok) {
            let msg = "Не удалось отказаться от заказа";
            try {
                const err = await response.json();
                if (err.detail) msg = typeof err.detail === "string" ? err.detail : JSON.stringify(err.detail);
            } catch (_) {}
            throw new Error(msg);
        }
        if (currentRequestDetail && currentRequestDetail.id === id) {
            await refetchCurrentRequestDetail(id, {
                refreshList: true,
                reloadHistory: true,
                reloadContract: !!currentRequestDetail.contract_created_at
            });
        } else {
            invalidateRequestCache(id);
            await loadRequests(true);
        }
        if (typeof showSuccess === "function") {
            showSuccess("Вы отказались от заказа.");
        }
    } catch (e) {
        debugError(e);
        if (typeof showError === "function") showError(e.message || String(e));
    }
}

async function completeRequest(requestId) {
    try {
        const requestResponse = await fetch(`${REQUESTS_API_URL}/requests/${requestId}`, {
            headers: getHeaders()
        });
        if (requestResponse.ok) {
            const request = await requestResponse.json();
            if (!request.assigned_driver_id) {
                if (typeof showError === "function") {
                    showError('Сначала назначьте водителя. Откройте детальный просмотр заявки и перейдите на вкладку "Перевозчик".');
                } else {
                    if (typeof showError === "function") {
                        showError('Сначала назначьте водителя. Откройте детальный просмотр заявки и перейдите на вкладку "Перевозчик".');
                    }
                }
                openRequestDetail(requestId);
                setTimeout(() => {
                    switchTab("carrier");
                }, 300);
                return;
            }
            if (!request.assigned_vehicle_id) {
                if (typeof showError === "function") {
                    showError('Сначала назначьте машину. Откройте детальный просмотр заявки и перейдите на вкладку "Перевозчик".');
                } else {
                    if (typeof showError === "function") {
                        showError('Сначала назначьте машину. Откройте детальный просмотр заявки и перейдите на вкладку "Перевозчик".');
                    }
                }
                openRequestDetail(requestId);
                setTimeout(() => {
                    switchTab("carrier");
                }, 300);
                return;
            }
            if (!request.contract_created_at) {
                if (typeof showError === "function") {
                    showError('Сначала создайте контракт. Откройте детальный просмотр заявки и перейдите на вкладку "Перевозчик".');
                } else {
                    if (typeof showError === "function") {
                        showError('Сначала создайте контракт. Откройте детальный просмотр заявки и перейдите на вкладку "Перевозчик".');
                    }
                }
                openRequestDetail(requestId);
                setTimeout(() => {
                    switchTab("carrier");
                }, 300);
                return;
            }
        }
    } catch (error) {
        console.error("Ошибка проверки условий:", error);
    }
    openRequestDetail(requestId);
    setTimeout(() => {
        const tabClosing = document.getElementById("tabClosing");
        if (tabClosing) {
            tabClosing.style.display = "block";
        }
        switchTab("closing");
    }, 300);
}

window.completeRequest = completeRequest;

window.carrierAcceptRequest = carrierAcceptRequest;

window.carrierDeclineRequest = carrierDeclineRequest;

function filterRequestsBySearch() {
    const searchInput = document.getElementById("requestsSearchInput");
    const clearButton = document.getElementById("requestsSearchClear");
    if (!searchInput) return;
    const searchTerm = searchInput.value.trim();
    currentSearchQuery = searchTerm;
    if (clearButton) {
        clearButton.style.display = searchTerm ? "flex" : "none";
    }
    displayRequests(getRequestsForDisplay());
}

function filterRequestsByQuery(requests, query) {
    if (!query || !requests) return requests;
    const searchTerm = query.toLowerCase().trim();
    return requests.filter(request => {
        if (request.id.toString().includes(searchTerm)) {
            return true;
        }
        const fromCity = (request.from_city || "").toLowerCase();
        const toCity = (request.to_city || "").toLowerCase();
        if (fromCity.includes(searchTerm) || toCity.includes(searchTerm)) {
            return true;
        }
        const fromAddress = (request.from_address || "").toLowerCase();
        const toAddress = (request.to_address || "").toLowerCase();
        if (fromAddress.includes(searchTerm) || toAddress.includes(searchTerm)) {
            return true;
        }
        const cargoType = (request.cargo_type || "").toLowerCase();
        if (cargoType.includes(searchTerm)) {
            return true;
        }
        const description = (request.description || "").toLowerCase();
        if (description.includes(searchTerm)) {
            return true;
        }
        const title = (request.title || "").toLowerCase();
        if (title.includes(searchTerm)) {
            return true;
        }
        if (request.max_price && request.max_price.toString().includes(searchTerm)) {
            return true;
        }
        return false;
    });
}

function clearRequestsSearch() {
    const searchInput = document.getElementById("requestsSearchInput");
    if (searchInput) {
        searchInput.value = "";
        currentSearchQuery = "";
        filterRequestsBySearch();
    }
}

window.filterRequestsBySearch = filterRequestsBySearch;

window.clearRequestsSearch = clearRequestsSearch;

window.setRequestListMode = setRequestListMode;

window.resetMarketFilters = resetMarketFilters;

window.toggleMarketFiltersPanel = toggleMarketFiltersPanel;

window.applyMarketQuickFilter = applyMarketQuickFilter;

function initRequestHandlers() {
    const createBtn = document.getElementById("createRequestBtn");
    if (createBtn) {
        createBtn.replaceWith(createBtn.cloneNode(true));
        const newBtn = document.getElementById("createRequestBtn");
        newBtn.addEventListener("click", e => {
            e.preventDefault();
            openCreateModal();
        });
    }
    document.querySelectorAll(".market-tab[data-list-mode]").forEach(btn => {
        btn.addEventListener("click", () => setRequestListMode(btn.dataset.listMode));
    });
    const resetBtn = document.getElementById("filterResetBtn");
    if (resetBtn) {
        resetBtn.addEventListener("click", e => {
            e.preventDefault();
            resetMarketFilters();
        });
    }
    const marketFiltersToggle = document.getElementById("marketFiltersToggle");
    if (marketFiltersToggle) {
        marketFiltersToggle.addEventListener("click", e => {
            e.preventDefault();
            toggleMarketFiltersPanel();
        });
    }
    document.querySelectorAll(".market-quick-chip[data-quick]").forEach(chip => {
        chip.addEventListener("click", e => {
            e.preventDefault();
            applyMarketQuickFilter(chip.dataset.quick);
        });
    });
    let marketFilterDebounce;
    [ "filterFromCity", "filterToCity", "filterPriceMin", "filterPriceMax", "filterDateFrom", "filterDateTo" ].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener("input", () => {
            clearTimeout(marketFilterDebounce);
            marketFilterDebounce = setTimeout(() => {
                displayRequests(getRequestsForDisplay());
            }, 200);
        });
        el.addEventListener("change", () => {
            displayRequests(getRequestsForDisplay());
        });
    });
    const tbody = document.getElementById("requestsTableBody");
    if (tbody) {
        tbody.removeEventListener("click", handleRowClick);
        tbody.addEventListener("click", handleRowClick);
    }
    initBidModalForm();
}

function initRequests() {
    loadUserData();
    updateMarketTitles();
    updateRequestsMarketCount(0);
    loadRequestBodyTypeOptionsFromMeta().catch(function() {});
    initRequestHandlers();
    initWinnerModalListeners();
    initCarrierProfilePhoneReveal();
    loadRequests().then(() => {
        const hash = window.location.hash;
        if (hash && hash.startsWith("#request-")) {
            const requestId = parseInt(hash.replace("#request-", ""));
            if (requestId && !isNaN(requestId)) {
                setTimeout(() => {
                    openRequestDetail(requestId);
                }, 500);
            }
        }
    });
}

let savedScrollPosition = 0;

let bodyScrollLockDepth = 0;

function lockBodyScroll() {
    if (bodyScrollLockDepth === 0) {
        savedScrollPosition = window.scrollY || window.pageYOffset || document.documentElement.scrollTop;
        document.body.style.overflow = "hidden";
        document.body.style.position = "fixed";
        document.body.style.top = `-${savedScrollPosition}px`;
        document.body.style.width = "100%";
    }
    bodyScrollLockDepth++;
}

function unlockBodyScroll() {
    if (bodyScrollLockDepth === 0) return;
    bodyScrollLockDepth--;
    if (bodyScrollLockDepth === 0) {
        document.body.style.overflow = "";
        document.body.style.position = "";
        document.body.style.top = "";
        document.body.style.width = "";
        window.scrollTo(0, savedScrollPosition);
    }
}

let currentAssignRequestId = null;

async function openAssignDriverModal() {
    if (!currentRequestDetail) return;
    currentAssignRequestId = currentRequestDetail.id;
    document.getElementById("assignDriverModal").style.display = "flex";
    try {
        const response = await fetch(`${API_URL}/api/drivers`, {
            headers: getHeaders()
        });
        if (!response.ok) {
            throw new Error("Ошибка загрузки водителей");
        }
        const drivers = await response.json();
        displayDriversForSelection(drivers);
    } catch (error) {
        console.error("Ошибка:", error);
        document.getElementById("driversList").innerHTML = `\n      <div class="empty">\n        <div class="empty-title">Ошибка загрузки водителей</div>\n        <div class="empty-text">${error.message}</div>\n      </div>\n    `;
    }
}

function displayDriversForSelection(drivers) {
    const driversList = document.getElementById("driversList");
    if (!driversList) return;
    if (drivers.length === 0) {
        driversList.innerHTML = `\n      <div class="empty">\n        <div class="empty-icon"></div>\n        <div class="empty-title">Нет водителей</div>\n        <div class="empty-text">Сначала добавьте водителей в разделе "Водители"</div>\n      </div>\n    `;
        return;
    }
    driversList.innerHTML = drivers.map(driver => {
        const birthDate = driver.birth_date ? new Date(driver.birth_date).toLocaleDateString("ru-RU") : "Не указана";
        const phone = driver.phone || "Не указан";
        return `\n      <div class="driver-selection-item" data-driver-id="${driver.id}">\n        <div class="driver-selection-content">\n          <div class="driver-selection-name">${driver.full_name}</div>\n          <div class="driver-selection-info">Дата рождения: ${birthDate}</div>\n          <div class="driver-selection-info">Телефон: ${phone}</div>\n        </div>\n        <button class="btn-select-driver" onclick="assignDriver(${driver.id})">\n          Выбрать\n        </button>\n      </div>\n    `;
    }).join("");
}

async function assignDriver(driverId) {
    const rid = currentAssignRequestId;
    if (rid == null) return;
    try {
        const response = await fetch(`${REQUESTS_API_URL}/requests/${rid}/assign-driver?driver_id=${driverId}`, {
            method: "POST",
            headers: getHeaders()
        });
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || "Ошибка назначения водителя");
        }
        const data = await response.json();
        closeAssignDriverModal();
        await refetchCurrentRequestDetail(rid, {
            refreshList: true,
            reloadHistory: true,
            reloadContract: !!currentRequestDetail?.contract_created_at
        });
        switchTab("carrier");
        if (typeof showSuccess === "function") {
            showSuccess("Водитель успешно назначен!");
        }
    } catch (error) {
        console.error("Ошибка:", error);
        if (typeof showError === "function") {
            showError(error.message);
        }
    }
}

function closeAssignDriverModal() {
    document.getElementById("assignDriverModal").style.display = "none";
    unlockBodyScroll();
    currentAssignRequestId = null;
}

async function openAssignVehicleModal() {
    if (!currentRequestDetail) return;
    currentAssignRequestId = currentRequestDetail.id;
    document.getElementById("assignVehicleModal").style.display = "flex";
    lockBodyScroll();
    try {
        const response = await fetch(`${API_URL}/api/vehicles`, {
            headers: getHeaders()
        });
        if (!response.ok) {
            throw new Error("Ошибка загрузки машин");
        }
        const vehicles = await response.json();
        displayVehiclesForSelection(vehicles);
    } catch (error) {
        console.error("Ошибка:", error);
        document.getElementById("vehiclesList").innerHTML = `\n      <div class="empty">\n        <div class="empty-title">Ошибка загрузки машин</div>\n        <div class="empty-text">${error.message}</div>\n      </div>\n    `;
    }
}

function displayVehiclesForSelection(vehicles) {
    const vehiclesList = document.getElementById("vehiclesList");
    if (!vehiclesList) return;
    if (vehicles.length === 0) {
        vehiclesList.innerHTML = `\n      <div class="empty">\n        <div class="empty-icon"></div>\n        <div class="empty-title">Нет машин</div>\n        <div class="empty-text">Сначала добавьте машины в разделе "Машины"</div>\n      </div>\n    `;
        return;
    }
    vehiclesList.innerHTML = vehicles.map(vehicle => {
        const vehicleInfo = [];
        if (vehicle.tractor_brand && vehicle.tractor_license_plate) {
            vehicleInfo.push(`${vehicle.tractor_brand} ${vehicle.tractor_license_plate}`);
        }
        if (vehicle.trailer_brand && vehicle.trailer_license_plate) {
            vehicleInfo.push(`${vehicle.trailer_brand} ${vehicle.trailer_license_plate}`);
        }
        const vehicleDescription = vehicleInfo.length > 0 ? vehicleInfo.join(", ") : `ID: ${vehicle.id}`;
        return `\n      <div class="vehicle-selection-item" data-vehicle-id="${vehicle.id}">\n        <div class="vehicle-selection-content">\n          <div class="vehicle-selection-name">${vehicleDescription}</div>\n          <div class="vehicle-selection-info">Состав: ${vehicle.composition_label_ru || vehicle.vehicle_type || "—"}</div>\n          ${vehicle.body_type_label_ru || vehicle.body_type ? `<div class="vehicle-selection-info">Кузов: ${vehicle.body_type_label_ru || vehicle.body_type}</div>` : ""}\n        </div>\n        <button class="btn-select-vehicle" onclick="assignVehicle(${vehicle.id})">\n          Выбрать\n        </button>\n      </div>\n    `;
    }).join("");
}

async function assignVehicle(vehicleId) {
    const rid = currentAssignRequestId;
    if (rid == null) return;
    try {
        const response = await fetch(`${REQUESTS_API_URL}/requests/${rid}/assign-vehicle?vehicle_id=${vehicleId}`, {
            method: "POST",
            headers: getHeaders()
        });
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || "Ошибка назначения машины");
        }
        const data = await response.json();
        closeAssignVehicleModal();
        await refetchCurrentRequestDetail(rid, {
            refreshList: true,
            reloadHistory: true,
            reloadContract: !!currentRequestDetail?.contract_created_at
        });
        switchTab("carrier");
        if (typeof showSuccess === "function") {
            showSuccess("Машина успешно назначена!");
        }
    } catch (error) {
        console.error("Ошибка:", error);
        if (typeof showError === "function") {
            showError(error.message);
        }
    }
}

function closeAssignVehicleModal() {
    document.getElementById("assignVehicleModal").style.display = "none";
    unlockBodyScroll();
    currentAssignRequestId = null;
}

async function createContract() {
    if (!currentRequestDetail) return;
    const confirmed = await showConfirm("Создать договор-заявку?\nПосле создания договор-заявка будет сгенерирован и заявка станет согласованной.\nДанные заявки больше нельзя будет изменить.", "Создание договора-заявки", "Создать", "Отмена");
    if (!confirmed) {
        return;
    }
    try {
        const response = await fetch(`${REQUESTS_API_URL}/requests/${currentRequestDetail.id}/create-contract`, {
            method: "POST",
            headers: getHeaders()
        });
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || "Ошибка создания контракта");
        }
        await response.json();
        await refetchCurrentRequestDetail(currentRequestDetail.id, {
            refreshList: true,
            reloadHistory: true,
            reloadContract: true
        });
        switchTab("carrier");
        if (typeof showSuccess === "function") {
            showSuccess("Договор-заявка успешно создан! Заявка согласована, данные зафиксированы. Теперь договор-заявка нужно подписать обеими сторонами.");
        }
    } catch (error) {
        console.error("Ошибка:", error);
        if (typeof showError === "function") {
            showError(error.message);
        } else {
            if (typeof showError === "function") {
                showError(error.message);
            }
        }
    }
}

async function loadRequestHistory() {
    if (!currentRequestDetail) {
        debugWarn("loadRequestHistory: currentRequestDetail не установлен");
        return;
    }
    const requestId = currentRequestDetail.id;
    if (!requestId) {
        console.error("loadRequestHistory: requestId не найден в currentRequestDetail", currentRequestDetail);
        return;
    }
    const historyContainer = document.getElementById("requestHistory");
    if (!historyContainer) return;
    try {
        debugLog(`Загрузка истории для заявки ID: ${requestId}`);
        const response = await fetch(`${REQUESTS_API_URL}/requests/${requestId}/history`, {
            headers: getHeaders()
        });
        if (!response.ok) {
            const errorText = await response.text();
            console.error(`Ошибка загрузки истории для заявки ${requestId}:`, response.status, errorText);
            if (response.status === 403 || response.status === 404) {
                historyContainer.innerHTML = `\n      <div class="empty">\n        <div class="empty-title">Доступ к истории ограничен</div>\n        <div class="empty-text">История изменений доступна только участникам заявки.</div>\n      </div>\n    `;
                return;
            }
            throw new Error("Ошибка загрузки истории");
        }
        const history = await response.json();
        debugLog(`Загружено записей истории для заявки ${requestId}:`, history.length);
        const wrongHistory = history.filter(h => h.request_id !== requestId);
        if (wrongHistory.length > 0) {
            console.error(`ОШИБКА: Найдены записи истории с неправильным request_id!`, wrongHistory);
        }
        displayRequestHistory(history);
        const historyList = document.getElementById("historyList");
        if (historyList) {
            historyList.dataset.loaded = "1";
        }
    } catch (error) {
        console.error("Ошибка загрузки истории:", error);
        const historyList = document.getElementById("historyList");
        if (historyList && !historyList.dataset.loaded) {
            historyList.innerHTML = `\n      <div class="empty">\n        <div class="empty-title">Ошибка загрузки истории</div>\n        <div class="empty-text">${error.message === "Ошибка загрузки истории" ? "Не удалось загрузить историю изменений." : error.message}</div>\n      </div>\n    `;
        }
    }
}

function displayRequestHistory(history) {
    const historyList = document.getElementById("historyList");
    const historyContainer = historyList || document.getElementById("requestHistory");
    if (!historyContainer) return;
    if (historyContainer.dataset.loaded) return;
    if (history.length === 0) {
        historyContainer.innerHTML = `\n      <div class="empty">\n        <div class="empty-icon"></div>\n        <div class="empty-title">История пуста</div>\n      </div>\n    `;
        return;
    }
    const currentRequestId = currentRequestDetail?.id;
    if (currentRequestId) {
        const wrongHistory = history.filter(h => h.request_id !== currentRequestId);
        if (wrongHistory.length > 0) {
            console.error(`[ОШИБКА] Найдены записи истории с неправильным request_id!`, {
                currentRequestId: currentRequestId,
                wrongHistory: wrongHistory.map(h => ({
                    id: h.id,
                    request_id: h.request_id,
                    event: h.event_type
                }))
            });
            history = history.filter(h => h.request_id === currentRequestId);
        }
    }
    const eventTypeNames = {
        winner_determined: "Определён победитель",
        driver_assigned: "Назначен водитель",
        vehicle_assigned: "Назначено транспортное средство",
        contract_created: "Создан договор-заявка",
        contract_approved: "Контракт согласован",
        contract_rejected: "Контракт отклонён",
        contract_document_uploaded: "Загружен документ",
        contract_signed: "Договор подписан",
        transportation_started: "Перевозка начата",
        request_completed: "Заявка завершена",
        request_archived: "Заявка в архиве",
        carrier_accepted: "Перевозчик подтвердил заказ",
        carrier_declined: "Перевозчик отказался",
        bid_updated: "Ставка обновлена",
        completion_requested: "Запрошено завершение"
    };
    const milestoneEvents = new Set([ "winner_determined", "carrier_accepted", "contract_created", "contract_signed", "transportation_started", "request_completed" ]);
    const sorted = [ ...history ].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    historyContainer.innerHTML = `<ul class="rd-history">${sorted.map(item => {
        const date = new Date(item.created_at);
        const dateStr = date.toLocaleDateString("ru-RU", {
            day: "numeric",
            month: "long",
            year: "numeric"
        });
        const timeStr = date.toLocaleTimeString("ru-RU", {
            hour: "2-digit",
            minute: "2-digit"
        });
        const eventName = eventTypeNames[item.event_type] || item.event_type;
        const milestone = milestoneEvents.has(item.event_type);
        const desc = item.description ? escapeHtmlBid(item.description) : "";
        return `\n      <li class="rd-history__item${milestone ? " rd-history__item--milestone" : ""}">\n        <div class="rd-history__rail" aria-hidden="true"><span class="rd-history__dot"></span></div>\n        <div class="rd-history__content">\n          <div class="rd-history__title">${escapeHtmlBid(eventName)}</div>\n          ${desc ? `<div class="rd-history__desc">${desc}</div>` : ""}\n          <div class="rd-history__time">${timeStr} · ${dateStr}</div>\n        </div>\n      </li>`;
    }).join("")}</ul>`;
    historyContainer.dataset.loaded = "1";
}

async function loadContractInfo(requestId) {
    const contractContent = document.getElementById("contractContent");
    if (!contractContent) return;
    let requestData = null;
    if (currentRequestDetail && currentRequestDetail.id === requestId) {
        requestData = currentRequestDetail;
    } else {
        try {
            const requestResponse = await fetch(`${REQUESTS_API_URL}/requests/${requestId}`, {
                headers: getHeaders()
            });
            if (requestResponse.ok) {
                requestData = await requestResponse.json();
            }
        } catch (e) {
            console.error("Ошибка загрузки заявки:", e);
        }
    }
    if (requestData && requestData.contract_created_at) {
        try {
            const response = await fetch(`${REQUESTS_API_URL}/requests/${requestId}/contract`, {
                headers: getHeaders()
            });
            if (response.ok) {
                const contract = await response.json();
                displayContract(contract);
                return;
            } else if (response.status === 404) {
                const contractDate = new Date(requestData.contract_created_at).toLocaleString("ru-RU");
                contractContent.innerHTML = `\n          <div class="detail-section">\n            <h3>Информация о контракте</h3>\n            <div class="detail-grid">\n              <div class="detail-item full-width">\n                <label>Статус</label>\n                <div style="color: #10b981; font-weight: 600;">✓ Контракт создан</div>\n              </div>\n              <div class="detail-item full-width">\n                <label>Дата создания</label>\n                <div>${contractDate}</div>\n              </div>\n              ${requestData.assigned_driver_name ? `\n                <div class="detail-item full-width">\n                  <label>Водитель</label>\n                  <div>${requestData.assigned_driver_name}${requestData.assigned_driver_phone ? `, тел.: ${requestData.assigned_driver_phone}` : ""}</div>\n                </div>\n              ` : ""}\n              ${requestData.assigned_vehicle_info ? `\n                <div class="detail-item full-width">\n                  <label>Транспортное средство</label>\n                  <div>${requestData.assigned_vehicle_info}</div>\n                </div>\n              ` : ""}\n            </div>\n            <div style="margin-top: 20px; padding: 12px; background: #f0f9ff; border: 1px solid #4a90e2; border-radius: 6px;">\n              <div style="font-size: 13px; color: #666;">\n                Контракт создан и ожидает полной загрузки данных. Детальная информация будет доступна позже.\n              </div>\n            </div>\n          </div>\n        `;
                return;
            } else if (response.status === 403) {
                contractContent.innerHTML = `\n        <div class="empty">\n          <div class="empty-title">Доступ к контракту ограничен</div>\n          <div class="empty-text">Контракт содержит конфиденциальные данные и доступен только участникам заявки.</div>\n        </div>\n      `;
                return;
            }
            const errorData = await response.json().catch(() => null);
            throw new Error(errorData?.detail || "Ошибка загрузки контракта");
        } catch (error) {
            console.error("Ошибка загрузки контракта:", error);
            if (requestData && requestData.contract_created_at) {
                const contractDate = new Date(requestData.contract_created_at).toLocaleString("ru-RU");
                contractContent.innerHTML = `\n          <div class="detail-section">\n            <h3>Информация о контракте</h3>\n            <div class="detail-grid">\n              <div class="detail-item full-width">\n                <label>Статус</label>\n                <div style="color: #10b981; font-weight: 600;">✓ Контракт создан</div>\n              </div>\n              <div class="detail-item full-width">\n                <label>Дата создания</label>\n                <div>${contractDate}</div>\n              </div>\n            </div>\n            <div style="margin-top: 20px; padding: 12px; background: #fff3cd; border: 1px solid #ffc107; border-radius: 6px;">\n              <div style="font-size: 13px; color: #856404;">\n                ${error.message === "Нет доступа к контракту этой заявки" ? "Доступ к детальной информации ограничен. Контракт виден только участникам заявки." : `Ошибка загрузки детальной информации о контракте: ${error.message}`}\n              </div>\n            </div>\n          </div>\n        `;
                return;
            }
            contractContent.innerHTML = `\n        <div class="empty">\n          <div class="empty-title">Ошибка загрузки контракта</div>\n          <div class="empty-text">${error.message === "Нет доступа к контракту этой заявки" ? "Доступ ограничен. Контракт виден только участникам заявки." : error.message}</div>\n        </div>\n      `;
        }
    } else {
        contractContent.innerHTML = `\n      <div class="empty">\n        <div class="empty-icon"></div>\n        <div class="empty-title">Контракт не создан</div>\n        <div class="empty-text">Перевозчик еще не создал контракт</div>\n      </div>\n    `;
    }
}

function escapeHtmlContract(s) {
    if (s == null || s === void 0) return "";
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function downloadProtectedContractDocument(filePath, filename) {
    if (!filePath) return;
    try {
        const baseUrl = REQUESTS_API_URL;
        const normalizedPath = String(filePath).replace(/^contracts\//, "");
        const encodedPath = normalizedPath.split("/").map(segment => encodeURIComponent(segment)).join("/");
        const response = await fetch(`${baseUrl}/contracts/${encodedPath}`, {
            headers: getHeaders()
        });
        if (!response.ok) {
            const error = await response.json().catch(() => null);
            throw new Error(error?.detail || "Не удалось скачать документ");
        }
        const blob = await response.blob();
        if (!blob.size) {
            throw new Error("Получен пустой файл");
        }
        const blobUrl = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = blobUrl;
        link.download = filename || filePath.split("/").pop() || "document.pdf";
        link.style.display = "none";
        document.body.appendChild(link);
        link.click();
        setTimeout(() => {
            if (link.parentNode) document.body.removeChild(link);
            try { URL.revokeObjectURL(blobUrl); } catch (e) {}
        }, 300000);
    } catch (error) {
        console.error("Ошибка скачивания документа:", error);
        if (typeof showError === "function") {
            showError(error.message || "Не удалось скачать документ");
        } else {
            alert(error.message || "Не удалось скачать документ");
        }
    }
}

function parseContractSignatureState(contract) {
    let customerSigned = false;
    let carrierSigned = false;
    let bothSigned = false;
    if (contract.signature_cert_data) {
        try {
            const signaturesData = JSON.parse(contract.signature_cert_data);
            customerSigned = signaturesData.customer && signaturesData.customer !== null;
            carrierSigned = signaturesData.carrier && signaturesData.carrier !== null;
            bothSigned = customerSigned && carrierSigned;
        } catch (e) {
            carrierSigned = contract.signature_xml !== null;
        }
    }
    return {
        customerSigned: customerSigned,
        carrierSigned: carrierSigned,
        bothSigned: bothSigned
    };
}

function getContractBaseUrl() {
    return REQUESTS_API_URL.replace("/api", "");
}

function isContractFullyComplete(contract, sig) {
    return sig.bothSigned && contract.signed_document_path && contract.document_path && contract.power_of_attorney_path && contract.power_of_attorney_signature_xml && contract.signed_power_of_attorney_path;
}

function buildContractSignatureCompactHtml(contract) {
    if (!contract.signature_cert_data) return "";
    try {
        const signaturesData = JSON.parse(contract.signature_cert_data);
        if (signaturesData.customer === void 0 && signaturesData.carrier === void 0) {
            return "";
        }
        const customerSigned = signaturesData.customer && signaturesData.customer !== null;
        const carrierSigned = signaturesData.carrier && signaturesData.carrier !== null;
        if (!customerSigned || !carrierSigned) return "";
        const cDate = signaturesData.customer_signed_at ? new Date(signaturesData.customer_signed_at).toLocaleString("ru-RU") : "";
        const caDate = signaturesData.carrier_signed_at ? new Date(signaturesData.carrier_signed_at).toLocaleString("ru-RU") : "";
        return `\n      <div class="contract-tab-sig-compact">\n        <div class="contract-tab-sig-compact-title">Подписи сторон</div>\n        <div class="contract-tab-sig-compact-rows">\n          <div class="contract-tab-sig-compact-row">\n            <span class="contract-tab-sig-compact-ok" aria-hidden="true">✓</span>\n            <span class="contract-tab-sig-compact-text">Заказчик подписал</span>\n            ${cDate ? `<span class="contract-tab-sig-compact-date">${escapeHtmlContract(cDate)}</span>` : ""}\n          </div>\n          <div class="contract-tab-sig-compact-row">\n            <span class="contract-tab-sig-compact-ok" aria-hidden="true">✓</span>\n            <span class="contract-tab-sig-compact-text">Перевозчик подписал</span>\n            ${caDate ? `<span class="contract-tab-sig-compact-date">${escapeHtmlContract(caDate)}</span>` : ""}\n          </div>\n        </div>\n      </div>\n    `;
    } catch (e) {
        return "";
    }
}

function buildContractFinalDocumentsBlockHtml(contract, isParticipant) {
    // Если пользователь не участник контракта - не показываем документы
    if (!isParticipant) {
        return "";
    }

    const signedName = contract.signed_document_path.replace("contracts/", "");
    const origName = contract.document_path.split("/").pop();
    const poaName = contract.signed_power_of_attorney_path.replace("contracts/", "");
    return `\n    <section class="contract-tab-final-docs" aria-labelledby="contract-final-docs-title">\n      <h3 id="contract-final-docs-title" class="contract-tab-final-docs-heading">Документы</h3>\n      <p class="contract-tab-final-docs-intro">Документы подписаны электронной подписью и содержат QR для проверки.</p>\n      <ul class="contract-tab-final-doclist">\n        <li class="contract-tab-final-doclist-item contract-tab-final-doclist-item--primary">\n          <span class="contract-tab-final-doclist-label">Подписанный договор (с QR)</span>\n          <button type="button" class="btn-login contract-tab-btn contract-tab-final-doc-btn" onclick='downloadProtectedContractDocument(${JSON.stringify(`contracts/${signedName}`)}, ${JSON.stringify(signedName)})'>Скачать</button>\n        </li>\n        <li class="contract-tab-final-doclist-item contract-tab-final-doclist-item--secondary">\n          <span class="contract-tab-final-doclist-label">Доверенность (с QR)</span>\n          <button type="button" class="btn-outline contract-tab-btn contract-tab-final-doc-btn" onclick='downloadProtectedContractDocument(${JSON.stringify(contract.signed_power_of_attorney_path)}, ${JSON.stringify(poaName)})'>Скачать</button>\n        </li>\n        <li class="contract-tab-final-doclist-item contract-tab-final-doclist-item--tertiary">\n          <span class="contract-tab-final-doclist-label">Оригинал договора без подписи</span>\n          <button type="button" class="btn-secondary contract-tab-btn contract-tab-final-doc-btn" onclick='downloadProtectedContractDocument(${JSON.stringify(`contracts/${origName}`)}, ${JSON.stringify(origName)})'>Скачать</button>\n        </li>\n      </ul>\n    </section>\n  `;
}

function buildContractFinalTransportHtml(contract) {
    return `\n    <section class="contract-tab-final-transport" aria-labelledby="contract-final-transport-title">\n      <h3 id="contract-final-transport-title" class="contract-tab-final-section-h">Перевозка</h3>\n      <div class="contract-tab-final-transport-grid">\n        <div>\n          <div class="contract-tab-final-muted">Машина</div>\n          <div class="contract-tab-final-strong">${escapeHtmlContract(contract.vehicle_info || "—")}</div>\n        </div>\n        <div>\n          <div class="contract-tab-final-muted">Водитель</div>\n          <div class="contract-tab-final-strong">${escapeHtmlContract(contract.driver_name || "—")}</div>\n        </div>\n      </div>\n    </section>\n  `;
}

function buildContractFinalDetailsHtml(contract) {
    const dateRows = [];
    if (contract.created_at) {
        dateRows.push({
            k: "Создан",
            v: new Date(contract.created_at).toLocaleString("ru-RU")
        });
    }
    if (contract.approved_at) {
        dateRows.push({
            k: "Утверждён",
            v: new Date(contract.approved_at).toLocaleString("ru-RU")
        });
    }
    if (contract.document_uploaded_at) {
        dateRows.push({
            k: "Договор загружен",
            v: new Date(contract.document_uploaded_at).toLocaleString("ru-RU")
        });
    }
    if (contract.signed_at) {
        dateRows.push({
            k: "Договор подписан",
            v: new Date(contract.signed_at).toLocaleString("ru-RU")
        });
    }
    const datesHtml = dateRows.length > 0 ? `\n    <div class="contract-tab-final-group">\n      <h4 class="contract-tab-final-group-title">Даты</h4>\n      <div class="contract-tab-final-kv">\n        ${dateRows.map(row => `\n          <div class="contract-tab-final-kv-row">\n            <span>${escapeHtmlContract(row.k)}</span>\n            <span>${escapeHtmlContract(row.v)}</span>\n          </div>`).join("")}\n      </div>\n    </div>` : "";
    return `\n    <section class="contract-tab-final-details" aria-labelledby="contract-final-details-title">\n      <h3 id="contract-final-details-title" class="contract-tab-final-section-h">Сведения</h3>\n      <div class="contract-tab-final-details-grid">\n        <div class="contract-tab-final-group">\n          <h4 class="contract-tab-final-group-title">Участники</h4>\n          <div class="contract-tab-final-kv">\n            <div class="contract-tab-final-kv-row">\n              <span>Перевозчик</span>\n              <span>${escapeHtmlContract(contract.carrier_name || "")}</span>\n            </div>\n            <div class="contract-tab-final-kv-row">\n              <span>Заказчик</span>\n              <span>${escapeHtmlContract(contract.customer_name || "")}</span>\n            </div>\n          </div>\n        </div>\n        ${datesHtml}\n      </div>\n    </section>\n  `;
}

function buildContractFinalLayoutHtml(contract, isParticipant) {
    const sigCompact = buildContractSignatureCompactHtml(contract);
    const docsHtml = buildContractFinalDocumentsBlockHtml(contract, isParticipant);
    const transportHtml = buildContractFinalTransportHtml(contract);
    const detailsHtml = buildContractFinalDetailsHtml(contract);
    return `\n    <div class="contract-tab contract-tab--final">\n      <header class="contract-tab-final-hero">\n        <div class="contract-tab-final-hero-badge"><span class="contract-tab-final-hero-badge-text">Контракт завершён</span><span class="contract-tab-final-hero-check" aria-hidden="true">✓</span></div>\n        <p class="contract-tab-final-hero-title">Договор подписан обеими сторонами</p>\n        <p class="contract-tab-final-hero-sub">Все документы оформлены, перевозка может выполняться по заявке.</p>\n      </header>\n\n      ${docsHtml}\n\n      ${sigCompact ? `<div class="contract-tab-final-sig-wrap">${sigCompact}</div>` : ""}\n\n      ${transportHtml}\n\n      ${detailsHtml}\n\n      <footer class="contract-tab-final-closure">\n        <p class="contract-tab-final-closure-line">Перевозка готова к выполнению</p>\n        <p class="contract-tab-final-closure-sub">Можно приступать к перевозке</p>\n      </footer>\n    </div>\n  `;
}

function getContractStepperUi(contract, sig) {
    const rejected = contract.status === "rejected";
    const pending = contract.status === "pending_approval";
    const bothSigned = sig.bothSigned;
    const poaDone = contract.power_of_attorney_signature_xml && contract.signed_power_of_attorney_path;
    const steps = [ {
        key: "created",
        label: "Создан"
    }, {
        key: "approval",
        label: "Ожидает утверждения заказчиком"
    }, {
        key: "signed",
        label: "Подписан"
    }, {
        key: "done",
        label: "Завершён"
    } ];
    let headline = "";
    let subline = "";
    const stepStates = [ "pending", "pending", "pending", "pending" ];
    if (rejected) {
        headline = "Отклонён заказчиком";
        subline = contract.rejection_reason ? "Причина: " + escapeHtmlContract(contract.rejection_reason) : "";
        stepStates[0] = "done";
        stepStates[1] = "error";
    } else if (pending) {
        headline = "Ожидает утверждения заказчиком";
        subline = "Контракт отправлен заказчику на подтверждение";
        stepStates[0] = "done";
        stepStates[1] = "current";
    } else if (!bothSigned) {
        headline = "Подписание договора";
        subline = "Подпишите договор-заявку через ЭЦП";
        stepStates[0] = "done";
        stepStates[1] = "done";
        stepStates[2] = "current";
    } else if (!poaDone) {
        headline = "Договор подписан";
        subline = "Завершите оформление доверенности";
        stepStates[0] = "done";
        stepStates[1] = "done";
        stepStates[2] = "done";
        stepStates[3] = "current";
    } else {
        headline = "Процесс завершён";
        subline = "Контракт и доверенность оформлены";
        stepStates[0] = "done";
        stepStates[1] = "done";
        stepStates[2] = "done";
        stepStates[3] = "done";
    }
    return {
        steps: steps,
        stepStates: stepStates,
        headline: headline,
        subline: subline,
        rejected: rejected
    };
}

function buildContractStepperHtml(ui) {
    const items = ui.steps.map((step, i) => {
        const st = ui.stepStates[i];
        let cls = "contract-tab-step";
        if (st === "done") cls += " contract-tab-step--done";
        if (st === "current") cls += " contract-tab-step--current";
        if (st === "error") cls += " contract-tab-step--error";
        if (st === "pending") cls += " contract-tab-step--pending";
        return `<div class="${cls}" role="listitem"><span class="contract-tab-step-num">${i + 1}</span><span class="contract-tab-step-label">${escapeHtmlContract(step.label)}</span></div>`;
    });
    const subHtml = ui.subline ? `<p class="contract-tab-headline-sub">${escapeHtmlContract(ui.subline)}</p>` : "";
    return `\n    <div class="contract-tab-headline">\n      <div class="contract-tab-headline-title">${escapeHtmlContract(ui.headline)}</div>\n      ${subHtml}\n    </div>\n    <div class="contract-tab-stepper" role="list">\n      ${items.join("")}\n    </div>\n  `;
}

function buildContractSummaryStripHtml(contract) {
    const v = escapeHtmlContract(contract.vehicle_info || "—");
    const d = escapeHtmlContract(contract.driver_name || "—");
    return `\n    <div class="contract-tab-summary-strip">\n      <div class="contract-tab-summary-item">\n        <span class="contract-tab-summary-label">Машина</span>\n        <span class="contract-tab-summary-value">${v}</span>\n      </div>\n      <div class="contract-tab-summary-item">\n        <span class="contract-tab-summary-label">Водитель</span>\n        <span class="contract-tab-summary-value">${d}</span>\n      </div>\n    </div>\n  `;
}

function buildContractInfoGroupsHtml(contract) {
    const approvedDate = contract.approved_at ? new Date(contract.approved_at).toLocaleString("ru-RU") : "—";
    const documentDate = contract.document_uploaded_at ? new Date(contract.document_uploaded_at).toLocaleString("ru-RU") : "—";
    const signedDate = contract.signed_at ? new Date(contract.signed_at).toLocaleString("ru-RU") : "—";
    const createdDate = contract.created_at ? new Date(contract.created_at).toLocaleString("ru-RU") : "—";
    return `\n    <div class="contract-tab-section">\n      <h3 class="contract-tab-section-title">Информация о контракте</h3>\n      <div class="contract-tab-groups">\n        <div class="contract-tab-group">\n          <h4 class="contract-tab-group-title">Участники</h4>\n          <div class="contract-tab-kv">\n            <div class="contract-tab-kv-row"><span class="contract-tab-k">Перевозчик</span><span class="contract-tab-v">${escapeHtmlContract(contract.carrier_name || "Не указан")}</span></div>\n            <div class="contract-tab-kv-row"><span class="contract-tab-k">Заказчик</span><span class="contract-tab-v">${escapeHtmlContract(contract.customer_name || "Не указан")}</span></div>\n          </div>\n        </div>\n        <div class="contract-tab-group">\n          <h4 class="contract-tab-group-title">Перевозка</h4>\n          <div class="contract-tab-kv">\n            <div class="contract-tab-kv-row"><span class="contract-tab-k">Машина</span><span class="contract-tab-v">${escapeHtmlContract(contract.vehicle_info || "—")}</span></div>\n            <div class="contract-tab-kv-row"><span class="contract-tab-k">Водитель</span><span class="contract-tab-v">${escapeHtmlContract(contract.driver_name || "—")}</span></div>\n          </div>\n        </div>\n        <div class="contract-tab-group">\n          <h4 class="contract-tab-group-title">Даты</h4>\n          <div class="contract-tab-kv">\n            <div class="contract-tab-kv-row"><span class="contract-tab-k">Создание</span><span class="contract-tab-v">${escapeHtmlContract(createdDate)}</span></div>\n            <div class="contract-tab-kv-row"><span class="contract-tab-k">Утверждение</span><span class="contract-tab-v">${escapeHtmlContract(approvedDate)}</span></div>\n            <div class="contract-tab-kv-row"><span class="contract-tab-k">Загрузка договора</span><span class="contract-tab-v">${escapeHtmlContract(documentDate)}</span></div>\n            <div class="contract-tab-kv-row"><span class="contract-tab-k">Подписание</span><span class="contract-tab-v">${escapeHtmlContract(signedDate)}</span></div>\n          </div>\n        </div>\n      </div>\n    </div>\n  `;
}

function buildContractSignatureDetailsHtml(contract) {
    if (!contract.signature_cert_data) return "";
    try {
        const signaturesData = JSON.parse(contract.signature_cert_data);
        if (signaturesData.customer !== void 0 || signaturesData.carrier !== void 0) {
            const customerSigned = signaturesData.customer && signaturesData.customer !== null;
            const carrierSigned = signaturesData.carrier && signaturesData.carrier !== null;
            const bothSigned = customerSigned && carrierSigned;
            if (bothSigned) {
                return `\n        <div class="contract-tab-sig contract-tab-sig--ok">\n          <div class="contract-tab-sig-title">Подписи сторон</div>\n          <div class="contract-tab-sig-line"><strong>Заказчик:</strong> ${escapeHtmlContract(signaturesData.customer.full_name || "—")}${signaturesData.customer.iin ? ` (ИИН: ${escapeHtmlContract(signaturesData.customer.iin)})` : ""}${signaturesData.customer_signed_at ? ` — ${escapeHtmlContract(new Date(signaturesData.customer_signed_at).toLocaleString("ru-RU"))}` : ""}</div>\n          <div class="contract-tab-sig-line"><strong>Перевозчик:</strong> ${escapeHtmlContract(signaturesData.carrier.full_name || "—")}${signaturesData.carrier.iin ? ` (ИИН: ${escapeHtmlContract(signaturesData.carrier.iin)})` : ""}${signaturesData.carrier_signed_at ? ` — ${escapeHtmlContract(new Date(signaturesData.carrier_signed_at).toLocaleString("ru-RU"))}` : ""}</div>\n          ${contract.signed_document_path ? '<div class="contract-tab-sig-note">Подписанный документ содержит QR-код для проверки</div>' : ""}\n        </div>\n      `;
            }
            if (customerSigned || carrierSigned) {
                const signedBy = customerSigned ? "заказчиком" : "перевозчиком";
                const signerData = customerSigned ? signaturesData.customer : signaturesData.carrier;
                return `\n        <div class="contract-tab-sig contract-tab-sig--wait">\n          <div class="contract-tab-sig-title">Подпись ${signedBy}</div>\n          <div class="contract-tab-sig-line">${escapeHtmlContract(signerData.full_name || "—")}${signerData.iin ? ` (ИИН: ${escapeHtmlContract(signerData.iin)})` : ""}</div>\n          <div class="contract-tab-sig-note">Ожидается подпись ${customerSigned ? "перевозчика" : "заказчика"}</div>\n        </div>\n      `;
            }
        }
    } catch (e) {}
    try {
        const certData = JSON.parse(contract.signature_cert_data);
        return `\n        <div class="contract-tab-sig contract-tab-sig--legacy">\n          <div class="contract-tab-sig-title">Подпись ЭЦП</div>\n          <div class="contract-tab-sig-line">${escapeHtmlContract(certData.full_name || "—")}${certData.iin ? ` (ИИН: ${escapeHtmlContract(certData.iin)})` : ""}</div>\n          ${contract.signed_at ? `<div class="contract-tab-sig-line">${escapeHtmlContract(new Date(contract.signed_at).toLocaleString("ru-RU"))}</div>` : ""}\n        </div>\n      `;
    } catch (e2) {
        return "";
    }
}

function buildContractDocumentsSectionHtml(contract, isParticipant) {
    // Если пользователь не участник контракта - не показываем документы
    if (!isParticipant) {
        return "";
    }

    const base = getContractBaseUrl();
    const sigBlock = buildContractSignatureDetailsHtml(contract);
    let docMain = "";
    if (!contract.document_path) {
        docMain = `<p class="contract-tab-doc-hint">Договор будет доступен после утверждения заказчиком.</p>`;
    } else if (contract.signed_document_path) {
        const signedName = contract.signed_document_path.replace("contracts/", "");
        const origName = contract.document_path.split("/").pop();
        docMain = `\n      <div class="contract-tab-doc-links">\n        <button type="button" class="btn-login contract-tab-btn" onclick='downloadProtectedContractDocument(${JSON.stringify(`contracts/${signedName}`)}, ${JSON.stringify(signedName)})'>Скачать договор</button>\n        <button type="button" class="btn-outline contract-tab-btn" onclick='downloadProtectedContractDocument(${JSON.stringify(`contracts/${origName}`)}, ${JSON.stringify(origName)})'>Оригинал без подписи</button>\n      </div>\n      <p class="contract-tab-doc-note">Подписанный файл включает все страницы договора и страницу с электронной подписью.</p>\n    `;
    } else {
        const origName = contract.document_path.split("/").pop();
        docMain = `\n      <div class="contract-tab-doc-links">\n        <button type="button" class="btn-outline contract-tab-btn" onclick='downloadProtectedContractDocument(${JSON.stringify(`contracts/${origName}`)}, ${JSON.stringify(origName)})'>Скачать договор</button>\n      </div>\n    `;
    }
    const poaBlock = contract.status === "signed" && contract.signed_document_path && contract.power_of_attorney_path && contract.power_of_attorney_signature_xml && contract.signed_power_of_attorney_path ? `\n      <div class="contract-tab-doc-poa">\n        <button type="button" class="btn-login contract-tab-btn" onclick='downloadProtectedContractDocument(${JSON.stringify(contract.signed_power_of_attorney_path)}, ${JSON.stringify(contract.signed_power_of_attorney_path.split("/").pop())})'>Скачать подписанную доверенность (с QR)</button>\n      </div>\n    ` : "";
    return `\n    <div class="contract-tab-section contract-tab-section--docs">\n      <h3 class="contract-tab-section-title">Документы</h3>\n      ${docMain}\n      ${sigBlock}\n      ${poaBlock}\n    </div>\n  `;
}

function buildContractSecondaryActionsHtml(_contract) {
    return "";
}

function buildContractPrimaryActionsHtml(contract, ctx) {
    const {isCustomer: isCustomer, isCarrier: isCarrier, sig: sig} = ctx;
    const customerSigned = sig.customerSigned;
    const carrierSigned = sig.carrierSigned;
    const bothSigned = sig.bothSigned;
    let inner = "";
    if (isCustomer) {
        if (contract.document_path && !customerSigned) {
            inner = `\n        <p class="contract-tab-action-hint">Договор-заявка готова к подписанию через ЭЦП.</p>\n        <button type="button" class="btn-login contract-tab-btn contract-tab-btn--block" onclick="signContractWithECP(${contract.id})">Подписать через ЭЦП</button>\n      `;
        } else if (bothSigned) {
            inner = `\n        <p class="contract-tab-poa-lead">Контракт подписан обеими сторонами. Перевозчик сгенерирует доверенность.</p>\n      `;
        } else if (contract.status === "pending_approval" && !contract.document_path) {
            inner = `\n        <div class="contract-tab-customer-legacy">\n          <button type="button" class="btn-login contract-tab-btn contract-tab-btn--block" onclick="generatePowerOfAttorney(${contract.id})">Сгенерировать доверенность</button>\n          <div class="contract-tab-upload-block">\n            <label class="contract-tab-upload-label">Или загрузить готовый документ (PDF)</label>\n            <p class="contract-tab-action-hint">Документ будет подписан перевозчиком через ЭЦП</p>\n            <input type="file" id="contractDocumentInput" accept=".pdf" class="contract-tab-file-input">\n            <button type="button" class="btn-secondary contract-tab-btn" onclick="uploadContractDocument(${contract.id})">Загрузить договор</button>\n          </div>\n          <div class="contract-tab-approve-row">\n            <button type="button" class="btn-login contract-tab-btn" onclick="approveContract(${contract.id})">Утвердить контракт</button>\n            <button type="button" class="btn-secondary contract-tab-btn" onclick="openRejectContractModal(${contract.id})">Отклонить</button>\n          </div>\n        </div>\n      `;
        } else if (contract.status === "pending_approval" && contract.document_path) {
            inner = `\n        <div class="contract-tab-approve-row">\n          <button type="button" class="btn-login contract-tab-btn" onclick="approveContract(${contract.id})">Утвердить контракт</button>\n          <button type="button" class="btn-secondary contract-tab-btn" onclick="openRejectContractModal(${contract.id})">Отклонить</button>\n        </div>\n      `;
        } else if (contract.status === "approved" && !contract.document_path) {
            inner = `\n        <button type="button" class="btn-login contract-tab-btn contract-tab-btn--block" onclick="generatePowerOfAttorney(${contract.id})">Сгенерировать доверенность</button>\n        <div class="contract-tab-upload-block">\n          <label class="contract-tab-upload-label">Или загрузить готовый документ (PDF)</label>\n          <input type="file" id="contractDocumentInput" accept=".pdf" class="contract-tab-file-input">\n          <button type="button" class="btn-secondary contract-tab-btn" onclick="uploadContractDocument(${contract.id})">Загрузить договор</button>\n        </div>\n      `;
        }
    }
    if (isCarrier) {
        if (contract.status !== "pending_approval" && contract.document_path && !carrierSigned) {
            inner = `\n        <p class="contract-tab-action-hint">${customerSigned ? "Заказчик уже подписал. " : ""}Подпишите договор-заявку через ЭЦП.</p>\n        <button type="button" class="btn-login contract-tab-btn contract-tab-btn--block" onclick="signContractWithECP(${contract.id})">Подписать через ЭЦП</button>\n      `;
        } else if (bothSigned) {
            if (contract.power_of_attorney_path && !contract.power_of_attorney_signature_xml) {
                inner = `\n          <div class="contract-tab-warn">\n            <div class="contract-tab-warn-title">Доверенность не подписана</div>\n            <p class="contract-tab-action-hint">Подпишите доверенность через ЭЦП</p>\n          </div>\n          <button type="button" class="btn-login contract-tab-btn contract-tab-btn--block" onclick="signPowerOfAttorneyWithECP(${contract.id})">Подписать доверенность через ЭЦП</button>\n        `;
            } else if (contract.power_of_attorney_path && contract.power_of_attorney_signature_xml) {
                inner = `\n          <div class="contract-tab-success">\n            <p class="contract-tab-success-text">Доверенность подписана и доступна заказчику для скачивания.</p>\n          </div>\n        `;
            } else {
                inner = `\n          <p class="contract-tab-poa-lead">Контракт подписан обеими сторонами. Сгенерируйте доверенность.</p>\n          <button type="button" class="btn-login contract-tab-btn contract-tab-btn--block" onclick="generatePowerOfAttorney(${contract.id})">Сгенерировать доверенность</button>\n        `;
            }
        }
    }
    const canCarrierSign = isCarrier && contract.status !== "pending_approval" && contract.document_path && !contract.signature_xml && (contract.status === "document_uploaded" || contract.status === "approved");
    if (!inner && canCarrierSign) {
        inner = `\n      <p class="contract-tab-action-hint">Договор загружен. Подпишите документ через ЭЦП (NCALayer). Подписывает руководитель перевозчика.</p>\n      <button type="button" class="btn-login contract-tab-btn contract-tab-btn--block" onclick="signContractWithECP(${contract.id})">Подписать через ЭЦП</button>\n    `;
    }
    if (!inner && isCarrier && contract.status === "pending_approval") {
        inner = `\n      <div class="contract-tab-wait">\n        <p class="contract-tab-wait-text">Ожидаем подтверждение заказчика</p>\n        <p class="contract-tab-wait-sub">Нет активных действий на этом этапе</p>\n      </div>\n    `;
    }
    if (!inner) return "";
    return `<div class="contract-tab-actions-primary">${inner}</div>`;
}

function displayContract(contract) {
    const contractContent = document.getElementById("contractContent");
    if (!contractContent) return;
    const userStr = localStorage.getItem("user");
    const currentUser2 = userStr ? JSON.parse(userStr) : null;
    const isCustomer = currentUser2 && contract.customer_id === currentUser2.id;
    const isCarrier = currentUser2 && contract.carrier_id === currentUser2.id;
    const isParticipant = isCustomer || isCarrier;
    const sig = parseContractSignatureState(contract);
    if (isContractFullyComplete(contract, sig)) {
        contractContent.innerHTML = buildContractFinalLayoutHtml(contract, isParticipant);
        return;
    }
    const ui = getContractStepperUi(contract, sig);
    const stepperHtml = buildContractStepperHtml(ui);
    const summaryHtml = buildContractSummaryStripHtml(contract);
    const primaryActionsHtml = buildContractPrimaryActionsHtml(contract, {
        isCustomer: isCustomer,
        isCarrier: isCarrier,
        sig: sig
    });
    const secondaryActionsHtml = buildContractSecondaryActionsHtml(contract);
    const infoHtml = buildContractInfoGroupsHtml(contract);
    const docsHtml = buildContractDocumentsSectionHtml(contract, isParticipant);
    contractContent.innerHTML = `\n    <div class="contract-tab">\n      <div class="contract-tab-region contract-tab-region--status">\n        ${summaryHtml}\n        ${stepperHtml}\n      </div>\n      <div class="contract-tab-region contract-tab-region--action">\n        <h3 class="contract-tab-section-title">Действия</h3>\n        ${primaryActionsHtml}\n        ${secondaryActionsHtml}\n      </div>\n      <div class="contract-tab-region contract-tab-region--detail">\n        ${infoHtml}\n        ${docsHtml}\n      </div>\n    </div>\n  `;
}

async function refreshContractTab() {
    if (!currentRequestDetail) return;
    try {
        await loadContractInfo(currentRequestDetail.id);
    } catch (e) {
        console.error("refreshContractTab:", e);
    }
}

window.refreshContractTab = refreshContractTab;

async function approveContract(contractId) {
    const confirmed = await showConfirm("Утвердить контракт? После утверждения вы сможете загрузить договор.", "Утверждение контракта", "Утвердить", "Отмена");
    if (!confirmed) {
        return;
    }
    try {
        const response = await fetch(`${API_URL}/api/contracts/${contractId}/approve`, {
            method: "POST",
            headers: getHeaders()
        });
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || "Ошибка утверждения контракта");
        }
        const data = await response.json();
        if (currentRequestDetail) {
            await loadContractInfo(currentRequestDetail.id);
            await loadRequestHistory();
        }
        if (typeof showSuccess === "function") {
            showSuccess("Контракт успешно утвержден! Теперь можно загрузить договор.");
        }
    } catch (error) {
        console.error("Ошибка:", error);
        if (typeof showError === "function") {
            showError(error.message);
        } else {
            if (typeof showError === "function") {
                showError(error.message);
            }
        }
    }
}

function openRejectContractModal(contractId) {
    const reason = prompt("Укажите причину отклонения контракта:");
    if (reason === null) return;
    rejectContract(contractId, reason);
}

async function rejectContract(contractId, reason) {
    try {
        const formData = new FormData;
        if (reason) {
            formData.append("rejection_reason", reason);
        }
        const response = await fetch(`${API_URL}/api/contracts/${contractId}/reject`, {
            method: "POST",
            headers: {
                "X-User-Id": JSON.parse(localStorage.getItem("user")).id.toString()
            },
            body: formData
        });
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || "Ошибка отклонения контракта");
        }
        const data = await response.json();
        if (currentRequestDetail) {
            await loadContractInfo(currentRequestDetail.id);
            await loadRequestHistory();
        }
        if (typeof showSuccess === "function") {
            showSuccess("Контракт отклонен");
        }
    } catch (error) {
        console.error("Ошибка:", error);
        if (typeof showError === "function") {
            showError(error.message);
        } else {
            if (typeof showError === "function") {
                showError(error.message);
            }
        }
    }
}

async function uploadContractDocument(contractId) {
    const fileInput = document.getElementById("contractDocumentInput");
    if (!fileInput || !fileInput.files || !fileInput.files[0]) {
        if (typeof showError === "function") {
            showError("Выберите файл для загрузки");
        } else {
            if (typeof showError === "function") {
                showError("Выберите файл для загрузки");
            }
        }
        return;
    }
    const formData = new FormData;
    formData.append("document", fileInput.files[0]);
    try {
        const response = await fetch(`${API_URL}/api/contracts/${contractId}/upload-document`, {
            method: "POST",
            headers: {
                "X-User-Id": JSON.parse(localStorage.getItem("user")).id.toString()
            },
            body: formData
        });
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || "Ошибка загрузки договора");
        }
        const data = await response.json();
        if (currentRequestDetail) {
            await loadContractInfo(currentRequestDetail.id);
            await loadRequestHistory();
        }
        fileInput.value = "";
        if (typeof showSuccess === "function") {
            showSuccess("Договор успешно загружен! Перевозчик получит уведомление для подписания.");
        }
    } catch (error) {
        console.error("Ошибка:", error);
        if (typeof showError === "function") {
            showError(error.message);
        } else {
            if (typeof showError === "function") {
                showError(error.message);
            }
        }
    }
}

async function signContract(contractId) {
    const fileInput = document.getElementById("signedContractDocumentInput");
    if (!fileInput || !fileInput.files || !fileInput.files[0]) {
        if (typeof showError === "function") {
            showError("Выберите подписанный файл для загрузки");
        } else {
            if (typeof showError === "function") {
                showError("Выберите подписанный файл для загрузки");
            }
        }
        return;
    }
    const formData = new FormData;
    formData.append("signed_document", fileInput.files[0]);
    try {
        const response = await fetch(`${API_URL}/api/contracts/${contractId}/sign`, {
            method: "POST",
            headers: {
                "X-User-Id": JSON.parse(localStorage.getItem("user")).id.toString()
            },
            body: formData
        });
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || "Ошибка подписания договора");
        }
        const data = await response.json();
        if (currentRequestDetail) {
            await loadContractInfo(currentRequestDetail.id);
            await loadRequestHistory();
        }
        fileInput.value = "";
        if (typeof showSuccess === "function") {
            showSuccess("Договор успешно подписан и загружен!");
        }
    } catch (error) {
        console.error("Ошибка:", error);
        if (typeof showError === "function") {
            showError(error.message);
        } else {
            if (typeof showError === "function") {
                showError(error.message);
            }
        }
    }
}

async function signContractWithECP(contractId) {
    try {
        if (typeof window.loadNCALayer === "function") {
            await window.loadNCALayer();
        } else if (typeof NCALayerClient === "undefined") {
            await new Promise((resolve, reject) => {
                let attempts = 0;
                const checkInterval = setInterval(() => {
                    attempts++;
                    if (typeof NCALayerClient !== "undefined") {
                        clearInterval(checkInterval);
                        resolve();
                    } else if (attempts > 30) {
                        clearInterval(checkInterval);
                        reject(new Error("NCALayer не загружен"));
                    }
                }, 100);
                window.addEventListener("ncalayer-loaded", () => {
                    clearInterval(checkInterval);
                    resolve();
                }, {
                    once: true
                });
            });
        }
        const ncalayerClient = new NCALayerClient;
        await ncalayerClient.connect();
        const user = JSON.parse(localStorage.getItem("user"));
        const nonceResponse = await fetch(`${REQUESTS_API_URL}/contracts/${contractId}/sign-nonce`, {
            headers: getHeaders()
        });
        if (!nonceResponse.ok) {
            const error = await nonceResponse.json();
            throw new Error(error.detail || "Ошибка получения nonce для подписания");
        }
        const nonceData = await nonceResponse.json();
        const nonce = nonceData.nonce;
        const xmlToSign = `<?xml version="1.0"?><nonce>${nonce}</nonce>`;
        if (typeof showSuccess === "function") {
            showSuccess("Подписание документа... Пожалуйста, подтвердите подпись в NCALayer.");
        }
        const signedXml = await ncalayerClient.signXml("PKCS12", xmlToSign);
        const verifyResponse = await fetch(`${REQUESTS_API_URL}/contracts/${contractId}/verify-signature`, {
            method: "POST",
            headers: {
                ...getHeaders(),
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                signedXml: signedXml
            })
        });
        if (!verifyResponse.ok) {
            const error = await verifyResponse.json();
            throw new Error(error.detail || "Ошибка верификации подписи");
        }
        const verifyData = await verifyResponse.json();
        if (currentRequestDetail?.id) {
            await refetchCurrentRequestDetail(currentRequestDetail.id, {
                refreshList: true,
                reloadHistory: true,
                reloadContract: true
            });
        }
        if (typeof showSuccess === "function") {
            if (verifyData.both_signed) {
                showSuccess(`Договор-заявка подписан обеими сторонами! Теперь можно сгенерировать доверенность.`);
            } else {
                showSuccess(`Договор-заявка успешно подписан через ЭЦП! Подписант: ${verifyData.signer || "Не указан"}. Ожидается подпись второй стороны.`);
            }
        }
    } catch (error) {
        console.error("Ошибка подписания:", error);
        if (typeof showError === "function") {
            showError(error.message || "Ошибка подписания документа через ЭЦП. Убедитесь, что NCALayer установлен и запущен.");
        } else {
            alert("Ошибка: " + (error.message || "Ошибка подписания документа через ЭЦП"));
        }
    }
}

async function signPowerOfAttorneyWithECP(contractId) {
    try {
        if (typeof window.loadNCALayer === "function") {
            await window.loadNCALayer();
        } else if (typeof NCALayerClient === "undefined") {
            await new Promise((resolve, reject) => {
                let attempts = 0;
                const checkInterval = setInterval(() => {
                    attempts++;
                    if (typeof NCALayerClient !== "undefined") {
                        clearInterval(checkInterval);
                        resolve();
                    } else if (attempts > 30) {
                        clearInterval(checkInterval);
                        reject(new Error("NCALayer не загружен"));
                    }
                }, 100);
                window.addEventListener("ncalayer-loaded", () => {
                    clearInterval(checkInterval);
                    resolve();
                }, {
                    once: true
                });
            });
        }
        const ncalayerClient = new NCALayerClient;
        await ncalayerClient.connect();
        const nonceResponse = await fetch(`${REQUESTS_API_URL}/contracts/${contractId}/power-of-attorney/sign-nonce`, {
            headers: getHeaders()
        });
        if (!nonceResponse.ok) {
            const error = await nonceResponse.json();
            throw new Error(error.detail || "Ошибка получения nonce для подписания");
        }
        const nonceData = await nonceResponse.json();
        const nonce = nonceData.nonce;
        const xmlToSign = `<?xml version="1.0"?><nonce>${nonce}</nonce>`;
        if (typeof showSuccess === "function") {
            showSuccess("Подписание доверенности... Пожалуйста, подтвердите подпись в NCALayer.");
        }
        const signedXml = await ncalayerClient.signXml("PKCS12", xmlToSign);
        const verifyResponse = await fetch(`${REQUESTS_API_URL}/contracts/${contractId}/power-of-attorney/verify-signature`, {
            method: "POST",
            headers: {
                ...getHeaders(),
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                signedXml: signedXml
            })
        });
        if (!verifyResponse.ok) {
            const error = await verifyResponse.json();
            throw new Error(error.detail || "Ошибка верификации подписи");
        }
        await verifyResponse.json();
        if (currentRequestDetail?.id) {
            await refetchCurrentRequestDetail(currentRequestDetail.id, {
                refreshList: true,
                reloadHistory: false,
                reloadContract: true
            });
        }
        if (typeof showSuccess === "function") {
            showSuccess("Доверенность успешно подписана! Теперь она доступна для скачивания заказчиком.");
        }
    } catch (error) {
        console.error("Ошибка подписания доверенности:", error);
        if (typeof showError === "function") {
            showError(error.message || "Ошибка подписания доверенности через ЭЦП. Убедитесь, что NCALayer установлен и запущен.");
        } else {
            alert("Ошибка: " + (error.message || "Ошибка подписания доверенности через ЭЦП"));
        }
    }
}

async function generatePowerOfAttorney(contractId) {
    try {
        const response = await fetch(`${REQUESTS_API_URL}/contracts/${contractId}/generate-power-of-attorney`, {
            headers: getHeaders()
        });
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || "Ошибка генерации доверенности");
        }
        const contentType = response.headers.get("content-type");
        if (!contentType || !contentType.includes("application/pdf")) {
            throw new Error("Сервер вернул не PDF файл");
        }
        const blob = await response.blob();
        if (blob.size === 0) {
            throw new Error("Получен пустой PDF файл");
        }
        let filename = `power_of_attorney_${contractId}.pdf`;
        const contentDisposition = response.headers.get("content-disposition");
        if (contentDisposition) {
            const filenameMatch = contentDisposition.match(/filename\*?=['"]?([^'";]+)['"]?/i);
            if (filenameMatch && filenameMatch[1]) {
                let extractedFilename = filenameMatch[1];
                if (extractedFilename.includes("UTF-8''")) {
                    extractedFilename = decodeURIComponent(extractedFilename.split("UTF-8''")[1]);
                }
                filename = extractedFilename.replace(/['"]/g, "");
            }
        }
        const blobUrl = URL.createObjectURL(blob);
        const downloadLink = document.createElement("a");
        downloadLink.href = blobUrl;
        downloadLink.download = filename;
        downloadLink.style.display = "none";
        downloadLink.setAttribute("download", filename);
        downloadLink.setAttribute("target", "_blank");
        document.body.appendChild(downloadLink);
        downloadLink.click();
        setTimeout(() => {
            if (downloadLink.parentNode) {
                document.body.removeChild(downloadLink);
            }
        }, 100);
        setTimeout(() => {
            try {
                URL.revokeObjectURL(blobUrl);
            } catch (e) {}
        }, 6e4);
        if (typeof showSuccess === "function") {
            showSuccess("Доверенность успешно сгенерирована и скачана! Теперь подпишите её через ЭЦП.");
        }
        if (currentRequestDetail?.id) {
            await refetchCurrentRequestDetail(currentRequestDetail.id, {
                refreshList: true,
                reloadHistory: false,
                reloadContract: true
            });
        }
    } catch (error) {
        console.error("Ошибка генерации доверенности:", error);
        if (typeof showError === "function") {
            showError(error.message || "Ошибка генерации доверенности");
        } else {
            alert("Ошибка: " + (error.message || "Ошибка генерации доверенности"));
        }
    }
}

async function generateRequestDocument(requestId) {
    if (!requestId && currentRequestDetail) {
        requestId = currentRequestDetail.id;
    }
    if (!requestId) {
        if (typeof showError === "function") {
            showError("ID заявки не указан");
        } else {
            alert("Ошибка: ID заявки не указан");
        }
        return;
    }
    try {
        const directResponse = await fetch(`${REQUESTS_API_URL}/requests/${requestId}/generate-document`, {
            headers: getHeaders()
        });
        if (!directResponse.ok) {
            const error = await directResponse.json();
            throw new Error(error.detail || "Ошибка генерации документа");
        }
        const contentType = directResponse.headers.get("content-type");
        if (!contentType || !contentType.includes("application/pdf")) {
            throw new Error("Сервер вернул не PDF файл");
        }
        const blob = await directResponse.blob();
        if (blob.size === 0) {
            throw new Error("Получен пустой PDF файл");
        }
        let filename = `request_${requestId}_document.pdf`;
        const contentDisposition = directResponse.headers.get("content-disposition");
        if (contentDisposition) {
            const filenameMatch = contentDisposition.match(/filename\*?=['"]?([^'";]+)['"]?/i);
            if (filenameMatch && filenameMatch[1]) {
                let extractedFilename = filenameMatch[1];
                if (extractedFilename.includes("UTF-8''")) {
                    extractedFilename = decodeURIComponent(extractedFilename.split("UTF-8''")[1]);
                }
                filename = extractedFilename.replace(/['"]/g, "");
            }
        }
        const blobUrl = URL.createObjectURL(blob);
        const downloadLink = document.createElement("a");
        downloadLink.href = blobUrl;
        downloadLink.download = filename;
        downloadLink.style.display = "none";
        downloadLink.setAttribute("download", filename);
        downloadLink.setAttribute("target", "_blank");
        document.body.appendChild(downloadLink);
        downloadLink.click();
        setTimeout(() => {
            if (downloadLink.parentNode) {
                document.body.removeChild(downloadLink);
            }
        }, 100);
        setTimeout(() => {
            try {
                URL.revokeObjectURL(blobUrl);
            } catch (e) {}
        }, 6e4);
        if (typeof showSuccess === "function") {
            showSuccess("Документ заявки успешно сгенерирован и скачан!");
        }
    } catch (error) {
        console.error("Ошибка генерации документа заявки:", error);
        if (typeof showError === "function") {
            showError(error.message || "Ошибка генерации документа заявки");
        } else {
            alert("Ошибка: " + (error.message || "Ошибка генерации документа заявки"));
        }
    }
}

window.openAssignDriverModal = openAssignDriverModal;

window.generateRequestDocument = generateRequestDocument;

window.signContractWithECP = signContractWithECP;

window.signPowerOfAttorneyWithECP = signPowerOfAttorneyWithECP;

window.closeAssignDriverModal = closeAssignDriverModal;

window.assignDriver = assignDriver;

window.openAssignVehicleModal = openAssignVehicleModal;

window.closeAssignVehicleModal = closeAssignVehicleModal;

window.assignVehicle = assignVehicle;

window.lockBodyScroll = lockBodyScroll;

window.unlockBodyScroll = unlockBodyScroll;

window.createContract = createContract;

window.approveContract = approveContract;

window.rejectContract = rejectContract;

window.openRejectContractModal = openRejectContractModal;

window.uploadContractDocument = uploadContractDocument;

window.signContract = signContract;

window.generatePowerOfAttorney = generatePowerOfAttorney;

window.generateRequestDocument = generateRequestDocument;

window.generateAct = generateAct;

window.signActWithECP = signActWithECP;

window.generateInvoice = generateInvoice;

window.loadClosingInfo = loadClosingInfo;

async function loadClosingInfo(requestId) {
    const closingContent = document.getElementById("closingContent");
    if (!closingContent) return;
    const pill = kind => {
        const cls = kind === "todo" ? "closing-flow__pill--todo" : kind === "progress" ? "closing-flow__pill--progress" : "closing-flow__pill--done";
        const label = kind === "todo" ? "Не начато" : kind === "progress" ? "В процессе" : "Завершено";
        return `<span class="closing-flow__pill ${cls}"><span class="closing-flow__pill-dot" aria-hidden="true"></span>${label}</span>`;
    };
    const icDoc = '<svg class="closing-flow__icon-svg" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" /></svg>';
    const icPen = '<svg class="closing-flow__icon-svg" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" /></svg>';
    try {
        const request = await getRequest(requestId, false);
        if (!request) {
            closingContent.innerHTML = '<div class="empty"><div class="empty-title">Заявка не найдена</div></div>';
            return;
        }
        const userStr = localStorage.getItem("user");
        const currentUser2 = userStr ? JSON.parse(userStr) : null;
        const isCarrier = currentUser2 && request.selected_carrier_id === currentUser2.id;
        const isCustomer = currentUser2 && request.customer_id === currentUser2.id;
        const isParticipant = isCarrier || isCustomer;

        // Если пользователь не участник сделки - не показываем документы
        if (!isParticipant) {
            closingContent.innerHTML = '<div class="empty"><div class="empty-title">Нет доступа</div><p class="empty-text">Документы доступны только участникам сделки</p></div>';
            return;
        }

        let customerSigned = false;
        let carrierSigned = false;
        let bothSigned = false;
        if (request.act_signature_cert_data) {
            try {
                const signaturesData = JSON.parse(request.act_signature_cert_data);
                customerSigned = signaturesData.customer && signaturesData.customer !== null;
                carrierSigned = signaturesData.carrier && signaturesData.carrier !== null;
                bothSigned = customerSigned && carrierSigned;
            } catch (e) {}
        }
        const hasAct = !!request.act_path;
        const hasInvoice = !!request.invoice_path;
        const baseUrl = REQUESTS_API_URL.replace("/api", "");
        const completedSteps = (hasAct ? 1 : 0) + (bothSigned ? 1 : 0) + (hasInvoice ? 1 : 0);
        let activeStep = 0;
        if (!hasAct) activeStep = 1; else if (!bothSigned) activeStep = 2; else if (!hasInvoice) activeStep = 3;
        const pill1 = !hasAct ? isCarrier ? pill("progress") : pill("todo") : pill("done");
        const pill2 = !hasAct ? pill("todo") : bothSigned ? pill("done") : pill("progress");
        const pill3 = !bothSigned ? pill("todo") : hasInvoice ? pill("done") : isCarrier ? pill("progress") : pill("todo");
        const stepperClass = n => {
            if (n === 1) return hasAct ? "closing-flow__stepper-node--done" : activeStep === 1 ? "closing-flow__stepper-node--current" : "closing-flow__stepper-node--pending";
            if (n === 2) {
                if (!hasAct) return "closing-flow__stepper-node--pending";
                return bothSigned ? "closing-flow__stepper-node--done" : "closing-flow__stepper-node--current";
            }
            if (!bothSigned) return "closing-flow__stepper-node--pending";
            return hasInvoice ? "closing-flow__stepper-node--done" : "closing-flow__stepper-node--current";
        };
        const conn12 = hasAct ? "closing-flow__stepper-connector--done" : "";
        const conn23 = bothSigned ? "closing-flow__stepper-connector--done" : "";
        if (request.status === "completed") {
            const signedActUrl = request.signed_act_path ? `${baseUrl}/contracts/${request.signed_act_path.replace("contracts/", "")}` : "";
            const invoiceUrl = hasInvoice ? `${baseUrl}/contracts/${request.invoice_path.replace("contracts/", "")}` : "";
            const actPlainUrl = hasAct ? `${baseUrl}/contracts/${request.act_path.replace("contracts/", "")}` : "";
            const actUrl = signedActUrl || actPlainUrl || "";
            const actLabel = signedActUrl ? "Подписанный акт" : "Акт";
            const iconCheck = '<svg class="closing-flow__complete-check-ico" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z" fill="currentColor" opacity="0.12"/><path d="M8.5 12.5l2.2 2.2 4.8-5.4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
            const iconDoc = '<svg class="closing-flow__doc-ico" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>';
            const iconInvoice = '<svg class="closing-flow__doc-ico" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M9 14l2 2 4-4M7 7h10M7 11h4"/><path stroke-linecap="round" stroke-linejoin="round" d="M5 5a2 2 0 012-2h6.172a2 2 0 011.414.586l2.828 2.828A2 2 0 0120 7.828V19a2 2 0 01-2 2H7a2 2 0 01-2-2V5z"/></svg>';
            const actBtn = actUrl ? `<button type="button" class="closing-flow__doc-btn closing-flow__doc-btn--primary" onclick='downloadProtectedContractDocument(${JSON.stringify(request.signed_act_path || request.act_path)}, ${JSON.stringify((request.signed_act_path || request.act_path).split("/").pop())})'>${iconDoc}<span>${actLabel}</span></button>` : "";
            const invBtn = invoiceUrl ? `<button type="button" class="closing-flow__doc-btn closing-flow__doc-btn--secondary" onclick='downloadProtectedContractDocument(${JSON.stringify(request.invoice_path)}, ${JSON.stringify(request.invoice_path.split("/").pop())})'>${iconInvoice}<span>Счёт-фактура</span></button>` : "";
            closingContent.innerHTML = `\n        <div class="closing-flow closing-flow--completed-state">\n          <div class="closing-flow__complete-card">\n            <div class="closing-flow__complete-status">\n              <div class="closing-flow__complete-icon-wrap">${iconCheck}</div>\n              <h3 class="closing-flow__complete-title">Перевозка успешно завершена</h3>\n              <p class="closing-flow__complete-sub">Все документы оформлены и доступны ниже</p>\n            </div>\n            <div class="closing-flow__complete-docs-block">\n              <p class="closing-flow__complete-docs-heading">Документы по заказу</p>\n              <div class="closing-flow__complete-doc-row">\n                ${actBtn}\n                ${invBtn}\n              </div>\n            </div>\n          </div>\n        </div>\n      `;
            return;
        }
        let step1Body = "";
        if (!hasAct) {
            if (isCarrier) {
                step1Body = `\n          <p class="closing-flow__desc">Подтверждает выполнение перевозки.</p>\n          <div class="closing-flow__actions">\n            <button type="button" class="btn-login contract-tab-btn contract-tab-btn--block" onclick="generateAct(${request.id})">Создать акт</button>\n          </div>\n        `;
            } else {
                step1Body = `\n          <p class="closing-flow__desc">Подтверждает выполнение перевозки. Перевозчик создаёт документ после выполнения перевозки.</p>\n        `;
            }
        } else {
            const actUrl = `${baseUrl}/contracts/${request.act_path.replace("contracts/", "")}`;
            let waitSub = "";
            if (!bothSigned) {
                if (customerSigned && !carrierSigned) waitSub = '<p class="closing-flow__status-sub">Ожидает подписания перевозчиком</p>'; else if (carrierSigned && !customerSigned) waitSub = '<p class="closing-flow__status-sub">Ожидает подписания заказчиком</p>'; else waitSub = '<p class="closing-flow__status-sub">Ожидает подписания сторонами</p>';
            }
            step1Body = `\n        <p class="closing-flow__desc">Акт создан. Подтверждает выполнение перевозки.</p>\n        <div class="closing-flow__actions">\n          <button type="button" class="btn-login contract-tab-btn contract-tab-btn--block" style="text-align:center;text-decoration:none;display:inline-block;" onclick='downloadProtectedContractDocument(${JSON.stringify(request.act_path)}, ${JSON.stringify(request.act_path.split("/").pop())})'>Открыть акт</button>\n        </div>\n        ${waitSub}\n      `;
        }
        let step2Body = "";
        if (!hasAct) {
            step2Body = `\n        <p class="closing-flow__desc">Стороны подписывают акт электронной подписью.</p>\n        <div class="closing-flow__actions">\n          <button type="button" class="btn-login contract-tab-btn contract-tab-btn--block closing-flow__btn-disabled" disabled>Подписать акт</button>\n          <p class="closing-flow__hint">Доступно после создания акта</p>\n        </div>\n      `;
        } else if (!bothSigned) {
            let partialNote = "";
            if (request.signed_act_path) {
                if (customerSigned && !carrierSigned) {
                    partialNote = `\n            <div class="closing-flow__note">\n              <div class="closing-flow__note-title">Подписан заказчиком</div>\n              <p class="closing-flow__note-text">Ожидается подпись перевозчика.</p>\n            </div>\n          `;
                } else if (carrierSigned && !customerSigned) {
                    partialNote = `\n            <div class="closing-flow__note">\n              <div class="closing-flow__note-title">Подписан перевозчиком</div>\n              <p class="closing-flow__note-text">Ожидается подпись заказчика.</p>\n            </div>\n          `;
                } else {
                    partialNote = `\n            <p class="closing-flow__desc">Требуется подпись через ЭЦП (NCALayer).</p>\n          `;
                }
            } else {
                partialNote = `\n          <p class="closing-flow__desc">Требуется подпись через ЭЦП (NCALayer).</p>\n        `;
            }
            const signBtnCustomer = !customerSigned && isCustomer ? `<button type="button" class="btn-login contract-tab-btn contract-tab-btn--block" onclick="signActWithECP(${request.id})">Подписать акт</button>` : "";
            const signBtnCarrier = !carrierSigned && isCarrier ? `<button type="button" class="btn-login contract-tab-btn contract-tab-btn--block" onclick="signActWithECP(${request.id})">Подписать акт</button>` : "";
            const signedActUrl = request.signed_act_path ? `${baseUrl}/contracts/${request.signed_act_path.replace("contracts/", "")}` : "";
            const downloadSigned = signedActUrl ? `<button type="button" class="closing-flow__link-secondary" onclick='downloadProtectedContractDocument(${JSON.stringify(request.signed_act_path)}, ${JSON.stringify(request.signed_act_path.split("/").pop())})'>Скачать подписанный файл</button>` : "";
            const actUrl = `${baseUrl}/contracts/${request.act_path.replace("contracts/", "")}`;
            const downloadDraft = !signedActUrl ? `<button type="button" class="closing-flow__link-secondary" onclick='downloadProtectedContractDocument(${JSON.stringify(request.act_path)}, ${JSON.stringify(request.act_path.split("/").pop())})'>Скачать без подписи</button>` : "";
            step2Body = `\n        ${partialNote}\n        <div class="closing-flow__actions">\n          ${signBtnCustomer}\n          ${signBtnCarrier}\n          <div class="closing-flow__actions-row">\n            ${downloadSigned}\n            ${downloadDraft}\n          </div>\n        </div>\n      `;
        } else {
            let sigDetails = "";
            if (request.act_signature_cert_data) {
                try {
                    const signaturesData = JSON.parse(request.act_signature_cert_data);
                    const cName = escapeHtmlContract(signaturesData.customer?.full_name || "Не указан");
                    const crName = escapeHtmlContract(signaturesData.carrier?.full_name || "Не указан");
                    const cDate = signaturesData.customer_signed_at ? ` — ${new Date(signaturesData.customer_signed_at).toLocaleString("ru-RU")}` : "";
                    const crDate = signaturesData.carrier_signed_at ? ` — ${new Date(signaturesData.carrier_signed_at).toLocaleString("ru-RU")}` : "";
                    sigDetails = `\n            <p class="closing-flow__sig-line"><strong>Заказчик:</strong> ${cName}${cDate}</p>\n            <p class="closing-flow__sig-line"><strong>Перевозчик:</strong> ${crName}${crDate}</p>\n          `;
                } catch (e) {
                    sigDetails = "";
                }
            }
            const signedActUrl = request.signed_act_path ? `${baseUrl}/contracts/${request.signed_act_path.replace("contracts/", "")}` : "";
            step2Body = `\n        <div class="closing-flow__success-inline">\n          <div class="closing-flow__success-inline-title">Акт подписан</div>\n          ${sigDetails}\n        </div>\n        ${signedActUrl ? `\n          <div class="closing-flow__actions">\n            <button type="button" class="btn-outline contract-tab-btn contract-tab-btn--block" style="text-align:center;display:inline-block;" onclick='downloadProtectedContractDocument(${JSON.stringify(request.signed_act_path)}, ${JSON.stringify(request.signed_act_path.split("/").pop())})'>Открыть подписанный акт</button>\n          </div>\n        ` : ""}\n      `;
        }
        let step3Body = "";
        if (!bothSigned) {
            step3Body = `\n        <p class="closing-flow__desc">Формируется после подписания акта.</p>\n        <div class="closing-flow__actions">\n          <button type="button" class="btn-login contract-tab-btn contract-tab-btn--block closing-flow__btn-disabled" disabled>Создать счёт-фактуру</button>\n          <p class="closing-flow__hint">Доступно после подписания</p>\n        </div>\n      `;
        } else if (!hasInvoice) {
            if (isCarrier) {
                step3Body = `\n          <p class="closing-flow__desc">После подписания акта можно сформировать счёт-фактуру.</p>\n          <div class="closing-flow__actions">\n            <button type="button" class="btn-login contract-tab-btn contract-tab-btn--block" onclick="generateInvoice(${request.id})">Создать счёт-фактуру</button>\n          </div>\n        `;
            } else {
                step3Body = `\n          <p class="closing-flow__desc">Перевозчик создаёт счёт-фактуру после подписания акта.</p>\n        `;
            }
        } else {
            const invoiceUrl = `${baseUrl}/contracts/${request.invoice_path.replace("contracts/", "")}`;
            const numLine = request.invoice_number ? `<div class="closing-flow__sig-line" style="margin-top:4px;">Номер: ${escapeHtmlContract(request.invoice_number)}</div>` : "";
            step3Body = `\n        <div class="closing-flow__success-inline">\n          <div class="closing-flow__success-inline-title">Счёт-фактура создана</div>\n          ${numLine}\n        </div>\n        <div class="closing-flow__actions">\n          <button type="button" class="btn-outline contract-tab-btn contract-tab-btn--block" style="text-align:center;display:inline-block;" onclick='downloadProtectedContractDocument(${JSON.stringify(request.invoice_path)}, ${JSON.stringify(request.invoice_path.split("/").pop())})'>Открыть счёт-фактуру</button>\n        </div>\n      `;
        }
        const completionPending = !!request.completion_requested_at && request.status !== "completed";
        let footerHtml = "";
        if (bothSigned && hasInvoice && request.status !== "completed") {
            if (isCarrier) {
                if (completionPending) {
                    footerHtml = `\n            <div class="closing-flow__footer">\n              <p class="closing-flow__desc" style="margin-bottom: 12px; padding-left: 0;">Запрос на завершение отправлен заказчику. Заявка закроется после его подтверждения.</p>\n            </div>\n          `;
                } else {
                    footerHtml = `\n            <div class="closing-flow__footer">\n              <p class="closing-flow__desc" style="margin-bottom: 12px; padding-left: 0;">Документы готовы. Отправьте заказчику запрос на завершение — после подтверждения заявка будет закрыта.</p>\n              <button type="button" class="btn-login contract-tab-btn contract-tab-btn--block" onclick="finalizeRequest(${request.id})">Отправить запрос на завершение</button>\n            </div>\n          `;
                }
            } else if (isCustomer) {
                if (completionPending) {
                    footerHtml = `\n            <div class="closing-flow__footer">\n              <p class="closing-flow__desc" style="margin-bottom: 12px; padding-left: 0;">Перевозчик запросил завершение заявки. Подтвердите, если перевоз выполнен и документы приняты.</p>\n              <button type="button" class="btn-login contract-tab-btn contract-tab-btn--block" onclick="confirmCustomerCompletion(${request.id})">Подтвердить завершение заявки</button>\n            </div>\n          `;
                } else {
                    footerHtml = `\n            <div class="closing-flow__footer">\n              <p class="closing-flow__desc" style="margin-bottom: 0; padding-left: 0;">После оформления счёт-фактуры перевозчик отправит запрос на завершение — подтвердите его здесь.</p>\n            </div>\n          `;
                }
            }
        }
        const stepClass = n => {
            const active = activeStep === n;
            const dim = n === 2 && !hasAct || n === 3 && !bothSigned;
            return `closing-flow__step${active ? " closing-flow__step--active" : ""}${dim ? " closing-flow__step--dim" : ""}`;
        };
        const progressPct = completedSteps / 3 * 100;
        closingContent.innerHTML = `\n      <div class="closing-flow">\n        <div class="closing-flow__top">\n          <h3 class="closing-flow__title">Завершение перевозки</h3>\n          <p class="closing-flow__progress-line">${completedSteps} из 3 шагов</p>\n          <div class="closing-flow__progress-bar" role="progressbar" aria-valuenow="${completedSteps}" aria-valuemin="0" aria-valuemax="3" aria-label="Прогресс закрытия перевозки">\n            <div class="closing-flow__progress-fill" style="width: ${progressPct}%;"></div>\n          </div>\n          <div class="closing-flow__stepper" aria-hidden="true">\n            <span class="closing-flow__stepper-node ${stepperClass(1)}">1</span>\n            <span class="closing-flow__stepper-connector ${conn12}"></span>\n            <span class="closing-flow__stepper-node ${stepperClass(2)}">2</span>\n            <span class="closing-flow__stepper-connector ${conn23}"></span>\n            <span class="closing-flow__stepper-node ${stepperClass(3)}">3</span>\n          </div>\n        </div>\n        <div class="closing-flow__body">\n          <section class="${stepClass(1)}">\n            <div class="closing-flow__step-head">\n              <span class="closing-flow__step-badgenum">1</span>\n              <div class="closing-flow__step-head-main">\n                <div class="closing-flow__step-title-row">\n                  <h4 class="closing-flow__step-title">${icDoc} Акт выполненных работ</h4>\n                  ${pill1}\n                </div>\n              </div>\n            </div>\n            ${step1Body}\n          </section>\n          <section class="${stepClass(2)}">\n            <div class="closing-flow__step-head">\n              <span class="closing-flow__step-badgenum">2</span>\n              <div class="closing-flow__step-head-main">\n                <div class="closing-flow__step-title-row">\n                  <h4 class="closing-flow__step-title">${icPen} Подписать акт (обе стороны)</h4>\n                  ${pill2}\n                </div>\n              </div>\n            </div>\n            ${step2Body}\n          </section>\n          <section class="${stepClass(3)}">\n            <div class="closing-flow__step-head">\n              <span class="closing-flow__step-badgenum">3</span>\n              <div class="closing-flow__step-head-main">\n                <div class="closing-flow__step-title-row">\n                  <h4 class="closing-flow__step-title">${icDoc} Счёт-фактура</h4>\n                  ${pill3}\n                </div>\n              </div>\n            </div>\n            ${step3Body}\n          </section>\n          ${footerHtml}\n        </div>\n      </div>\n    `;
    } catch (error) {
        console.error("Ошибка загрузки информации о закрытии:", error);
        closingContent.innerHTML = '<div class="empty"><div class="empty-title">Ошибка загрузки</div></div>';
    }
}

async function generateAct(requestId) {
    try {
        const response = await fetch(`${REQUESTS_API_URL}/requests/${requestId}/generate-act`, {
            headers: getHeaders()
        });
        if (!response.ok) {
            const error = await response.json();
            throw new Error(formatHttpErrorDetail(error.detail) || "Ошибка генерации акта");
        }
        const contentType = response.headers.get("content-type");
        if (!contentType || !contentType.includes("application/pdf")) {
            throw new Error("Сервер вернул не PDF файл");
        }
        const blob = await response.blob();
        if (blob.size === 0) {
            throw new Error("Получен пустой PDF файл");
        }
        let filename = `act_${requestId}.pdf`;
        const contentDisposition = response.headers.get("content-disposition");
        if (contentDisposition) {
            const filenameMatch = contentDisposition.match(/filename\*?=['"]?([^'";]+)['"]?/i);
            if (filenameMatch && filenameMatch[1]) {
                let extractedFilename = filenameMatch[1];
                if (extractedFilename.includes("UTF-8''")) {
                    extractedFilename = decodeURIComponent(extractedFilename.split("UTF-8''")[1]);
                }
                filename = extractedFilename.replace(/['"]/g, "");
            }
        }
        const blobUrl = URL.createObjectURL(blob);
        const newWindow = window.open(blobUrl, "_blank");
        if (!newWindow || newWindow.closed || typeof newWindow.closed === "undefined") {
            const downloadLink = document.createElement("a");
            downloadLink.href = blobUrl;
            downloadLink.download = filename;
            downloadLink.style.display = "none";
            document.body.appendChild(downloadLink);
            downloadLink.click();
            setTimeout(() => {
                if (downloadLink.parentNode) {
                    document.body.removeChild(downloadLink);
                }
            }, 100);
        }
        setTimeout(() => {
            try {
                URL.revokeObjectURL(blobUrl);
            } catch (e) {}
        }, 6e4);
        if (typeof showSuccess === "function") {
            showSuccess("Акт успешно создан! Документ открыт в новой вкладке. Теперь подпишите его через ЭЦП.");
        }
        if (currentRequestDetail?.id === requestId) {
            await refetchCurrentRequestDetail(requestId, {
                refreshList: true,
                reloadHistory: false,
                reloadContract: false
            });
            await loadClosingInfo(requestId);
        } else {
            invalidateRequestCache(requestId);
            await loadRequests(true);
        }
    } catch (error) {
        console.error("Ошибка генерации акта:", error);
        if (typeof showError === "function") {
            showError(error.message || "Ошибка генерации акта");
        } else {
            alert("Ошибка: " + (error.message || "Ошибка генерации акта"));
        }
    }
}

async function signActWithECP(requestId) {
    try {
        if (typeof window.loadNCALayer === "function") {
            await window.loadNCALayer();
        } else if (typeof NCALayerClient === "undefined") {
            await new Promise((resolve, reject) => {
                let attempts = 0;
                const checkInterval = setInterval(() => {
                    attempts++;
                    if (typeof NCALayerClient !== "undefined") {
                        clearInterval(checkInterval);
                        resolve();
                    } else if (attempts > 30) {
                        clearInterval(checkInterval);
                        reject(new Error("NCALayer не загружен"));
                    }
                }, 100);
                window.addEventListener("ncalayer-loaded", () => {
                    clearInterval(checkInterval);
                    resolve();
                }, {
                    once: true
                });
            });
        }
        const ncalayerClient = new NCALayerClient;
        await ncalayerClient.connect();
        const nonceResponse = await fetch(`${REQUESTS_API_URL}/requests/${requestId}/act/sign-nonce`, {
            headers: getHeaders()
        });
        if (!nonceResponse.ok) {
            const error = await nonceResponse.json();
            throw new Error(error.detail || "Ошибка получения nonce для подписания");
        }
        const nonceData = await nonceResponse.json();
        const nonce = nonceData.nonce;
        const xmlToSign = `<?xml version="1.0"?><nonce>${nonce}</nonce>`;
        if (typeof showSuccess === "function") {
            showSuccess("Подписание акта... Пожалуйста, подтвердите подпись в NCALayer.");
        }
        const signedXml = await ncalayerClient.signXml("PKCS12", xmlToSign);
        const verifyResponse = await fetch(`${REQUESTS_API_URL}/requests/${requestId}/act/verify-signature`, {
            method: "POST",
            headers: {
                ...getHeaders(),
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                signedXml: signedXml
            })
        });
        if (!verifyResponse.ok) {
            const error = await verifyResponse.json();
            throw new Error(error.detail || "Ошибка верификации подписи");
        }
        const result = await verifyResponse.json();
        if (typeof showSuccess === "function") {
            if (result.both_signed) {
                showSuccess("Акт подписан обеими сторонами! Теперь можно создать счет-фактуру.");
            } else {
                showSuccess("Акт успешно подписан! Ожидается подпись второй стороны.");
            }
        }
        if (currentRequestDetail?.id === requestId) {
            await refetchCurrentRequestDetail(requestId, {
                refreshList: true,
                reloadHistory: false,
                reloadContract: false
            });
            await loadClosingInfo(requestId);
        } else {
            invalidateRequestCache(requestId);
            await loadRequests(true);
        }
    } catch (error) {
        console.error("Ошибка подписания акта:", error);
        if (typeof showError === "function") {
            showError(error.message || "Ошибка подписания акта через ЭЦП. Убедитесь, что NCALayer установлен и запущен.");
        } else {
            alert("Ошибка: " + (error.message || "Ошибка подписания акта через ЭЦП"));
        }
    }
}

async function generateInvoice(requestId) {
    try {
        const response = await fetch(`${REQUESTS_API_URL}/requests/${requestId}/generate-invoice`, {
            headers: getHeaders()
        });
        if (!response.ok) {
            let errorBody;
            try {
                errorBody = await response.json();
            } catch {
                throw new Error(`HTTP ${response.status}`);
            }
            const detail = errorBody.detail;
            if (detail && typeof detail === "object" && detail.error_code === "PAYMENT_DETAILS_REQUIRED") {
                const missingFields = detail.missing_fields || [];
                if (typeof showPaymentDetailsRequiredModal === "function") {
                    showPaymentDetailsRequiredModal(missingFields);
                } else if (typeof showError === "function") {
                    showError(detail.message || "Для выставления счёта необходимо заполнить платёжные реквизиты");
                } else {
                    alert(detail.message || "Для выставления счёта необходимо заполнить платёжные реквизиты");
                }
                return;
            }
            throw new Error(formatHttpErrorDetail(detail) || "Ошибка генерации счет-фактуры");
        }
        const contentType = response.headers.get("content-type");
        if (!contentType || !contentType.includes("application/pdf")) {
            throw new Error("Сервер вернул не PDF файл");
        }
        const blob = await response.blob();
        if (blob.size === 0) {
            throw new Error("Получен пустой PDF файл");
        }
        let filename = `invoice_${requestId}.pdf`;
        const contentDisposition = response.headers.get("content-disposition");
        if (contentDisposition) {
            const filenameMatch = contentDisposition.match(/filename\*?=['"]?([^'";]+)['"]?/i);
            if (filenameMatch && filenameMatch[1]) {
                let extractedFilename = filenameMatch[1];
                if (extractedFilename.includes("UTF-8''")) {
                    extractedFilename = decodeURIComponent(extractedFilename.split("UTF-8''")[1]);
                }
                filename = extractedFilename.replace(/['"]/g, "");
            }
        }
        const blobUrl = URL.createObjectURL(blob);
        const newWindow = window.open(blobUrl, "_blank");
        if (!newWindow || newWindow.closed || typeof newWindow.closed === "undefined") {
            const downloadLink = document.createElement("a");
            downloadLink.href = blobUrl;
            downloadLink.download = filename;
            downloadLink.style.display = "none";
            document.body.appendChild(downloadLink);
            downloadLink.click();
            setTimeout(() => {
                if (downloadLink.parentNode) {
                    document.body.removeChild(downloadLink);
                }
            }, 100);
        }
        setTimeout(() => {
            try {
                URL.revokeObjectURL(blobUrl);
            } catch (e) {}
        }, 6e4);
        if (typeof showSuccess === "function") {
            showSuccess("Счет-фактура успешно создана! Документ открыт в новой вкладке. Теперь можно завершить заявку.");
        }
        if (currentRequestDetail?.id === requestId) {
            await refetchCurrentRequestDetail(requestId, {
                refreshList: true,
                reloadHistory: false,
                reloadContract: false
            });
            await loadClosingInfo(requestId);
        } else {
            invalidateRequestCache(requestId);
            await loadRequests(true);
        }
    } catch (error) {
        console.error("Ошибка генерации счет-фактуры:", error);
        if (typeof showError === "function") {
            showError(error.message || "Ошибка генерации счет-фактуры");
        } else {
            alert("Ошибка: " + (error.message || "Ошибка генерации счет-фактуры"));
        }
    }
}

async function finalizeRequest(requestId) {
    const confirmed = await showConfirm("Отправить заказчику запрос на завершение заявки? После его подтверждения заявка будет отмечена как исполненная.", "Завершение заявки", "Отправить", "Отмена", "#10b981");
    if (!confirmed) {
        return;
    }
    try {
        const response = await fetch(`${REQUESTS_API_URL}/requests/${requestId}/request-completion`, {
            method: "POST",
            headers: getHeaders()
        });
        if (!response.ok) {
            let msg = "Ошибка завершения заявки";
            try {
                const error = await response.json();
                const d = error.detail;
                msg = typeof d === "string" ? d : Array.isArray(d) ? d.map(x => x.msg || JSON.stringify(x)).join("; ") : msg;
            } catch (e) {}
            throw new Error(msg);
        }
        await response.json();
        if (typeof showSuccess === "function") {
            showSuccess("Запрос на завершение отправлен заказчику. После подтверждения заявка будет закрыта.");
        }
        if (currentRequestDetail && currentRequestDetail.id === requestId) {
            await refetchCurrentRequestDetail(requestId, {
                refreshList: true,
                reloadHistory: true,
                reloadContract: true
            });
            tabLoadState.closing = false;
            await loadClosingInfo(requestId);
            const carrierSetupPanel = document.getElementById("carrierSetupPanel");
            if (carrierSetupPanel) {
                carrierSetupPanel.style.display = "none";
            }
        } else {
            invalidateRequestCache(requestId);
            await loadRequests(true);
        }
    } catch (error) {
        console.error("Ошибка:", error);
        if (typeof showError === "function") {
            showError(error.message);
        }
    }
}

window.finalizeRequest = finalizeRequest;

async function confirmCustomerCompletion(requestId) {
    const confirmed = await showConfirm("Подтвердить завершение заявки? Заявка будет отмечена как исполненная.", "Подтверждение", "Подтвердить", "Отмена", "#10b981");
    if (!confirmed) {
        return;
    }
    try {
        const response = await fetch(`${REQUESTS_API_URL}/requests/${requestId}/confirm-completion`, {
            method: "POST",
            headers: getHeaders()
        });
        if (!response.ok) {
            let msg = "Не удалось подтвердить завершение";
            try {
                const error = await response.json();
                const d = error.detail;
                msg = typeof d === "string" ? d : Array.isArray(d) ? d.map(x => x.msg || JSON.stringify(x)).join("; ") : msg;
            } catch (e) {}
            throw new Error(msg);
        }
        await response.json();
        if (typeof showSuccess === "function") {
            showSuccess("Заявка завершена.");
        }
        if (currentRequestDetail && currentRequestDetail.id === requestId) {
            await refetchCurrentRequestDetail(requestId, {
                refreshList: true,
                reloadHistory: true,
                reloadContract: true
            });
            tabLoadState.closing = false;
            await loadClosingInfo(requestId);
        } else {
            invalidateRequestCache(requestId);
            await loadRequests(true);
        }
    } catch (error) {
        console.error("Ошибка:", error);
        if (typeof showError === "function") {
            showError(error.message);
        }
    }
}

window.confirmCustomerCompletion = confirmCustomerCompletion;

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initRequests);
} else {
    initRequests();
}
