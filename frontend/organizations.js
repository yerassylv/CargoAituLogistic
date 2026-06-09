function getApiBase() {
    return typeof API_URL !== "undefined" ? API_URL : "https://cargoaitulogistic.onrender.com";
}

function organizationsApiUrl(path) {
    const p = path.startsWith("/") ? path : "/" + path;
    return `${getApiBase()}/api${p}`;
}

function loadUserData() {
    const userData = localStorage.getItem("user");
    if (userData) {
        return JSON.parse(userData);
    }
    return null;
}

let _partnershipSignInProgress = false;

function escapeHtml(text) {
    if (!text) return "";
    const map = {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    };
    return String(text).replace(/[&<>"']/g, m => map[m]);
}

function orgCardInitials(name) {
    const n = (name || "").trim();
    if (!n) return "?";
    const parts = n.split(/\s+/).filter(Boolean).slice(0, 2);
    return parts.map(p => p[0]).join("").toUpperCase().slice(0, 2) || "?";
}

function formatPartnershipSignedDate(iso) {
    if (!iso) return null;
    try {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return null;
        return d.toLocaleDateString("ru-RU", {
            day: "numeric",
            month: "long",
            year: "numeric"
        });
    } catch (_) {
        return null;
    }
}

function orgCatalogCountLabel(n) {
    const k = Math.abs(n) % 100;
    const k1 = k % 10;
    if (k > 10 && k < 20) return `${n} компаний`;
    if (k1 === 1) return `${n} компания`;
    if (k1 >= 2 && k1 <= 4) return `${n} компании`;
    return `${n} компаний`;
}

function partnershipFlowKey(partnershipId) {
    return `cargoPartnershipFlow_${partnershipId}_v1`;
}

function getPartnershipFlow(partnershipId) {
    const empty = {
        registrySeen: false,
        contractSeen: false,
        signError: null
    };
    if (!partnershipId) return empty;
    try {
        const raw = sessionStorage.getItem(partnershipFlowKey(partnershipId));
        if (!raw) return empty;
        const o = JSON.parse(raw);
        return {
            registrySeen: Boolean(o.registrySeen),
            contractSeen: Boolean(o.contractSeen),
            signError: o.signError != null ? String(o.signError) : null
        };
    } catch (e) {
        return empty;
    }
}

function setPartnershipFlow(partnershipId, patch) {
    if (!partnershipId) return;
    const cur = {
        ...getPartnershipFlow(partnershipId),
        ...patch
    };
    sessionStorage.setItem(partnershipFlowKey(partnershipId), JSON.stringify(cur));
}

function clearPartnershipFlow(partnershipId) {
    if (!partnershipId) return;
    sessionStorage.removeItem(partnershipFlowKey(partnershipId));
}

function markPartnershipRegistrySeen(partnershipId) {
    setPartnershipFlow(partnershipId, {
        registrySeen: true
    });
}

function markPartnershipContractSeen(partnershipId) {
    setPartnershipFlow(partnershipId, {
        contractSeen: true
    });
}

function getPartnershipSignCurrentStep(flow) {
    if (!flow.registrySeen) return 1;
    if (!flow.contractSeen) return 2;
    return 3;
}

function stepperRowClass(done, current) {
    if (done) return "org-stepper__step org-stepper__step--done";
    if (current) return "org-stepper__step org-stepper__step--current";
    return "org-stepper__step org-stepper__step--upcoming";
}

function renderPartnershipSignFlowCard(org, flow, binAttr, pidAttr) {
    const pid = org.partnership_id;
    const name = escapeHtml(org.company_name || org.full_name);
    const step = getPartnershipSignCurrentStep(flow);
    const s1Done = flow.registrySeen;
    const s2Done = flow.contractSeen && flow.registrySeen;
    const statusLines = {
        1: "Требуется проверка данных в реестре",
        2: "Требуется ознакомление с договором",
        3: "Требуется ваше подписание ЭЦП"
    };
    const cls1 = stepperRowClass(s1Done, step === 1);
    const cls2 = stepperRowClass(s2Done, step === 2);
    const cls3 = stepperRowClass(false, step === 3);
    const errBlock = flow.signError ? `<div class="org-flow-alert org-flow-alert--error" role="alert">\n         <strong>Не удалось подписать</strong>\n         <p>${escapeHtml(flow.signError)}</p>\n         <button type="button" class="org-flow-alert-dismiss" data-action="clear-partnership-error" data-partnership-id="${pid}">Скрыть</button>\n       </div>` : "";
    const detailsBlock = `\n    <div class="organization-details organization-details--compact">\n      ${org.email ? `<div class="organization-detail"><strong>Email:</strong> ${escapeHtml(org.email)}</div>` : ""}\n      ${org.phone ? `<div class="organization-detail"><strong>Телефон:</strong> ${escapeHtml(org.phone)}</div>` : ""}\n      ${org.address ? `<div class="organization-detail"><strong>Адрес:</strong> ${escapeHtml(org.address)}</div>` : ""}\n    </div>`;
    return `\n    <div class="organization-card organization-card--flow">\n      <div class="organization-header organization-header--flow">\n        <div class="organization-info">\n          <h3 class="organization-name">${name}</h3>\n          ${org.bin ? `<div class="organization-bin">БИН: ${escapeHtml(org.bin)}</div>` : ""}\n        </div>\n        <span class="org-flow-chip org-flow-chip--action">Шаг ${step} из 3</span>\n      </div>\n\n      <div class="org-flow-hero">\n        <p class="org-flow-kicker">Договор партнёрства</p>\n        <h4 class="org-flow-title">${escapeHtml(statusLines[step] || statusLines[3])}</h4>\n        <p class="org-flow-desc">Проверьте контрагента в государственном реестре, ознакомьтесь с текстом договора и подпишите его квалифицированной ЭЦП.</p>\n      </div>\n\n      <div class="org-stepper" aria-label="Этапы подписания договора">\n        <div class="${cls1}">\n          <div class="org-stepper__marker" aria-hidden="true"><span class="org-stepper__check">✓</span><span class="org-stepper__num">1</span></div>\n          <div class="org-stepper__body">\n            <span class="org-stepper__label">Данные из реестра</span>\n            <span class="org-stepper__hint">Сверка с data.egov.kz по БИН</span>\n          </div>\n        </div>\n        <div class="${cls2}">\n          <div class="org-stepper__marker" aria-hidden="true"><span class="org-stepper__check">✓</span><span class="org-stepper__num">2</span></div>\n          <div class="org-stepper__body">\n            <span class="org-stepper__label">Текст договора</span>\n            <span class="org-stepper__hint">Ознакомление с условиями</span>\n          </div>\n        </div>\n        <div class="${cls3}">\n          <div class="org-stepper__marker" aria-hidden="true"><span class="org-stepper__check">✓</span><span class="org-stepper__num">3</span></div>\n          <div class="org-stepper__body">\n            <span class="org-stepper__label">Подписание ЭЦП</span>\n            <span class="org-stepper__hint">NCALayer / квалифицированная подпись</span>\n          </div>\n        </div>\n      </div>\n\n      ${detailsBlock}\n\n      ${errBlock}\n\n      <div class="org-flow-actions">\n        <div class="org-flow-primary">\n          <button type="button" class="org-flow-btn org-flow-btn--primary" data-action="sign" data-partnership-id="${pid}">\n            Подписать ЭЦП\n          </button>\n          <p class="org-flow-primary-hint">Откроется текст договора: отметьте ознакомление и подтвердите подпись в NCALayer.</p>\n        </div>\n        <div class="org-flow-secondary">\n          <button type="button" class="org-flow-btn org-flow-btn--secondary" data-action="egov-registry"${binAttr}${pidAttr}>Данные из реестра</button>\n          <button type="button" class="org-flow-btn org-flow-btn--secondary" data-action="agreement" data-partnership-id="${pid}">Текст договора</button>\n        </div>\n      </div>\n    </div>`;
}

function renderPartnershipWaitingCard(org, binAttr, pidAttr) {
    const pid = org.partnership_id;
    const name = escapeHtml(org.company_name || org.full_name);
    const detailsBlock = `\n    <div class="organization-details organization-details--compact">\n      ${org.email ? `<div class="organization-detail"><strong>Email:</strong> ${escapeHtml(org.email)}</div>` : ""}\n      ${org.phone ? `<div class="organization-detail"><strong>Телефон:</strong> ${escapeHtml(org.phone)}</div>` : ""}\n      ${org.address ? `<div class="organization-detail"><strong>Адрес:</strong> ${escapeHtml(org.address)}</div>` : ""}\n    </div>`;
    return `\n    <div class="organization-card organization-card--flow organization-card--waiting">\n      <div class="organization-header organization-header--flow">\n        <div class="organization-info">\n          <h3 class="organization-name">${name}</h3>\n          ${org.bin ? `<div class="organization-bin">БИН: ${escapeHtml(org.bin)}</div>` : ""}\n        </div>\n        <span class="org-flow-chip org-flow-chip--wait">Ожидание</span>\n      </div>\n      <div class="org-flow-waiting-banner">\n        <div class="org-flow-waiting-icon" aria-hidden="true">✓</div>\n        <div>\n          <strong>Ваша подпись получена</strong>\n          <p class="org-flow-waiting-text">Ожидаем подписания договора второй стороной. После этого партнёрство станет активным.</p>\n        </div>\n      </div>\n      <div class="org-stepper org-stepper--all-done" aria-hidden="true">\n        <div class="org-stepper__step org-stepper__step--done"><div class="org-stepper__marker"><span class="org-stepper__check">✓</span></div><div class="org-stepper__body"><span class="org-stepper__label">Реестр</span></div></div>\n        <div class="org-stepper__step org-stepper__step--done"><div class="org-stepper__marker"><span class="org-stepper__check">✓</span></div><div class="org-stepper__body"><span class="org-stepper__label">Договор</span></div></div>\n        <div class="org-stepper__step org-stepper__step--done"><div class="org-stepper__marker"><span class="org-stepper__check">✓</span></div><div class="org-stepper__body"><span class="org-stepper__label">ЭЦП</span></div></div>\n      </div>\n      ${detailsBlock}\n      <div class="org-flow-actions org-flow-actions--single">\n        <div class="org-flow-secondary">\n          <button type="button" class="org-flow-btn org-flow-btn--secondary" data-action="egov-registry"${binAttr}${pidAttr}>Данные из реестра</button>\n          <button type="button" class="org-flow-btn org-flow-btn--secondary" data-action="agreement" data-partnership-id="${pid}">Текст договора</button>\n        </div>\n      </div>\n    </div>`;
}

function renderPartnershipSignedCard(org, binAttr, pidAttr) {
    const pid = org.partnership_id;
    const displayName = org.company_name || org.full_name || "Партнёр";
    const name = escapeHtml(displayName);
    const initials = orgCardInitials(displayName);
    const signedLine = formatPartnershipSignedDate(org.partnership_signed_at);
    const detailsBlock = `\n    <div class="organization-details organization-details--compact partner-card-active__contact">\n      ${org.email ? `<div class="organization-detail"><strong>Email</strong> ${escapeHtml(org.email)}</div>` : ""}\n      ${org.phone ? `<div class="organization-detail"><strong>Телефон</strong> ${escapeHtml(org.phone)}</div>` : ""}\n      ${org.address ? `<div class="organization-detail"><strong>Адрес</strong> ${escapeHtml(org.address)}</div>` : ""}\n    </div>`;
    const metaSigned = signedLine ? `<p class="partner-card-active__signedline">Договор в силе · подписан ${escapeHtml(signedLine)}</p>` : `<p class="partner-card-active__signedline">Договор партнёрства подписан обеими сторонами</p>`;
    return `\n    <article class="organization-card organization-card--flow partner-card-active" data-partnership-id="${pid}">\n      <div class="partner-card-active__head">\n        <div class="org-card-identity" aria-hidden="true"><span class="org-card-avatar partner-card-active__avatar">${escapeHtml(initials)}</span></div>\n        <div class="partner-card-active__titleblock">\n          <div class="partner-card-active__title-row">\n            <h3 class="organization-name partner-card-active__title">${name}</h3>\n            <span class="partner-pill partner-pill--active" title="Партнёрство действует">\n              <span class="partner-pill__dot" aria-hidden="true"></span>\n              Активно\n            </span>\n          </div>\n          ${org.bin ? `<div class="org-card-meta"><span class="org-chip-bin">БИН ${escapeHtml(org.bin)}</span></div>` : ""}\n        </div>\n      </div>\n      ${metaSigned}\n      ${detailsBlock}\n      <div class="partner-card-active__footer">\n        <button type="button" class="partner-btn-doc" data-action="agreement" data-partnership-id="${pid}">\n          Открыть договор\n        </button>\n      </div>\n    </article>`;
}

function isOrganizationsCatalogOrg(org) {
    if (!org.has_partnership) return true;
    const s = org.partnership_status;
    return s === "rejected" || s === "expired";
}

function isPartnersSectionOrg(org) {
    return org.has_partnership && (org.partnership_status === "pending" || org.partnership_status === "signed");
}

function renderPartnerCard(org) {
    const mySigDone = org.partnership_my_signature_done === true;
    const binRaw = org.bin ? String(org.bin).trim() : "";
    const validBin = typeof isValidEgovBin === "function" && isValidEgovBin(binRaw);
    const binAttr = validBin ? ` data-bin="${escapeHtml(binRaw)}"` : "";
    const pidAttr = org.partnership_id != null ? ` data-partnership-id="${org.partnership_id}"` : "";
    if (org.partnership_status === "pending" && !mySigDone) {
        const flow = getPartnershipFlow(org.partnership_id);
        return renderPartnershipSignFlowCard(org, flow, binAttr, pidAttr);
    }
    if (org.partnership_status === "pending" && mySigDone) {
        return renderPartnershipWaitingCard(org, binAttr, pidAttr);
    }
    if (org.partnership_status === "signed") {
        return renderPartnershipSignedCard(org, binAttr, pidAttr);
    }
    return `\n    <div class="organization-card">\n      <div class="organization-header">\n        <div class="organization-info">\n          <h3 class="organization-name">${escapeHtml(org.company_name || org.full_name)}</h3>\n        </div>\n        <span class="status-badge status-gray">${escapeHtml(org.partnership_status || "—")}</span>\n      </div>\n      <p class="org-flow-desc" style="margin:0;font-size:14px;color:#64748b;">Обновите страницу или обратитесь в поддержку.</p>\n    </div>`;
}

function renderOrganizationCardSimple(org) {
    const binRaw = org.bin ? String(org.bin).trim() : "";
    const validBin = typeof isValidEgovBin === "function" && isValidEgovBin(binRaw);
    const binAttr = validBin ? ` data-bin="${escapeHtml(binRaw)}"` : "";
    const pidAttr = org.partnership_id != null ? ` data-partnership-id="${org.partnership_id}"` : "";
    const displayName = org.company_name || org.full_name || "Без названия";
    const initials = orgCardInitials(displayName);
    let statusBadgeClass = "org-badge org-badge--neutral";
    let statusLabel = "Нет партнёрства";
    if (org.has_partnership && org.partnership_status === "rejected") {
        statusBadgeClass = "org-badge org-badge--warning";
        statusLabel = "Запрос отклонён";
    } else if (org.has_partnership && org.partnership_status === "expired") {
        statusBadgeClass = "org-badge org-badge--muted";
        statusLabel = "Срок истёк";
    }
    const actionButton = org.has_partnership ? `<button type="button" class="org-btn org-btn--primary" data-action="create" data-org-id="${org.id}">Повторить запрос</button>` : `<button type="button" class="org-btn org-btn--primary" data-action="create" data-org-id="${org.id}">Заключить партнёрство</button>`;
    const registryBtn = `<button type="button" class="org-btn org-btn--secondary" data-action="egov-registry"${binAttr}${pidAttr}>Данные из реестра</button>`;
    const hasContact = !!(org.email || org.phone || org.address);
    const contactBlock = hasContact ? `<div class="org-card-contact">\n        ${org.email ? `<div class="org-card-contact__row"><span class="org-card-contact__key">Email</span><span class="org-card-contact__val">${escapeHtml(org.email)}</span></div>` : ""}\n        ${org.phone ? `<div class="org-card-contact__row"><span class="org-card-contact__key">Телефон</span><span class="org-card-contact__val">${escapeHtml(org.phone)}</span></div>` : ""}\n        ${org.address ? `<div class="org-card-contact__row"><span class="org-card-contact__key">Адрес</span><span class="org-card-contact__val">${escapeHtml(org.address)}</span></div>` : ""}\n      </div>` : `<p class="org-card-hint">Реквизиты не указаны — сверку по БИН всё равно можно открыть из реестра.</p>`;
    return `\n    <article class="organization-card org-catalog-card" data-org-id="${org.id}">\n      <div class="org-card-top">\n        <div class="org-card-identity" aria-hidden="true">\n          <span class="org-card-avatar">${escapeHtml(initials)}</span>\n        </div>\n        <div class="org-card-heading">\n          <div class="org-card-heading__row">\n            <h3 class="organization-name org-card-title">${escapeHtml(displayName)}</h3>\n            <span class="${statusBadgeClass}" role="status">${escapeHtml(statusLabel)}</span>\n          </div>\n          ${org.bin ? `<div class="org-card-meta"><span class="org-chip-bin">БИН ${escapeHtml(org.bin)}</span></div>` : '<div class="org-card-meta"><span class="org-chip-bin org-chip-bin--empty">БИН не указан</span></div>'}\n        </div>\n      </div>\n      ${contactBlock}\n      <div class="org-card-actions" role="group" aria-label="Действия по организации">\n        ${registryBtn}\n        ${actionButton}\n      </div>\n      <p class="org-card-footnote">Реестр — справочно. Партнёрство оформляется договором на платформе.</p>\n    </article>\n  `;
}

function orgApiHeaders() {
    const user = loadUserData();
    if (!user || !user.id) {
        throw new Error("Пользователь не авторизован");
    }
    return {
        "Content-Type": "application/json",
        "X-User-Id": user.id.toString()
    };
}

async function loadOrganizations(source = "database", opts = {}) {
    const skipSkeleton = opts.skipSkeleton === true;
    try {
        const headers = orgApiHeaders();
        const container = document.getElementById("organizationsContainer");
        const skeleton = document.getElementById("organizationsSkeleton");
        const content = document.getElementById("organizationsContent");
        const partnerSkeleton = document.getElementById("partnersSkeleton");
        const partnerContent = document.getElementById("partnersContent");
        if (!skipSkeleton && container && skeleton && content) {
            skeleton.classList.remove("hidden");
            content.classList.add("hidden");
        }
        if (!skipSkeleton && partnerSkeleton && partnerContent) {
            partnerSkeleton.classList.remove("hidden");
            partnerContent.classList.add("hidden");
        }
        const url = `${organizationsApiUrl("/organizations")}?source=database&_=${Date.now()}`;
        const response = await fetch(url, {
            headers: headers
        });
        if (!response.ok) {
            throw new Error("Ошибка загрузки организаций");
        }
        const organizations = await response.json();
        displayOrganizations(organizations, "database");
        displayPartners(organizations, "database");
    } catch (error) {
        console.error("Ошибка загрузки организаций:", error);
        if (error && error.message === "Пользователь не авторизован") {
            const container2 = document.getElementById("organizationsContainer");
            const skeleton2 = document.getElementById("organizationsSkeleton");
            const content2 = document.getElementById("organizationsContent");
            const partnerSkeleton2 = document.getElementById("partnersSkeleton");
            const partnerContent2 = document.getElementById("partnersContent");
            if (container2 && skeleton2 && content2) {
                skeleton2.classList.add("hidden");
                content2.classList.remove("hidden");
                content2.innerHTML = `\n        <div class="empty">\n          <div class="empty-title">Требуется вход</div>\n          <div class="empty-text">${escapeHtml(error.message)}</div>\n        </div>\n      `;
            }
            if (partnerSkeleton2 && partnerContent2) {
                partnerSkeleton2.classList.add("hidden");
                partnerContent2.classList.remove("hidden");
                partnerContent2.innerHTML = `\n        <div class="empty">\n          <div class="empty-title">Требуется вход</div>\n          <div class="empty-text">${escapeHtml(error.message)}</div>\n        </div>\n      `;
            }
            return;
        }
        const container = document.getElementById("organizationsContainer");
        const skeleton = document.getElementById("organizationsSkeleton");
        const content = document.getElementById("organizationsContent");
        const partnerSkeleton = document.getElementById("partnersSkeleton");
        const partnerContent = document.getElementById("partnersContent");
        if (container && skeleton && content) {
            skeleton.classList.add("hidden");
            content.classList.remove("hidden");
            content.innerHTML = `\n        <div class="empty">\n          <div class="empty-icon"></div>\n          <div class="empty-title">Ошибка загрузки</div>\n          <div class="empty-text">${escapeHtml(error.message)}</div>\n        </div>\n      `;
        }
        if (partnerSkeleton && partnerContent) {
            partnerSkeleton.classList.add("hidden");
            partnerContent.classList.remove("hidden");
            partnerContent.innerHTML = `\n        <div class="empty">\n          <div class="empty-icon"></div>\n          <div class="empty-title">Ошибка загрузки</div>\n          <div class="empty-text">${escapeHtml(error.message)}</div>\n        </div>\n      `;
        }
    }
}

function displayOrganizations(organizations, source = "database") {
    const container = document.getElementById("organizationsContainer");
    const skeleton = document.getElementById("organizationsSkeleton");
    const content = document.getElementById("organizationsContent");
    if (!container || !skeleton || !content) {
        console.error("Контейнеры организаций не найдены!");
        return;
    }
    const list = organizations.filter(isOrganizationsCatalogOrg);
    skeleton.classList.add("hidden");
    content.classList.remove("hidden");
    if (organizations.length === 0) {
        content.innerHTML = `\n      <div class="empty">\n        <div class="empty-icon"></div>\n        <div class="empty-title">Нет организаций</div>\n        <div class="empty-text">На платформе пока нет других компаний</div>\n      </div>\n    `;
        return;
    }
    if (list.length === 0) {
        content.innerHTML = `\n      <div class="empty">\n        <div class="empty-icon"></div>\n        <div class="empty-title">Все компании в партнёрах</div>\n        <div class="empty-text">Активные договоры и подписание — в разделе «Партнёры».</div>\n      </div>\n    `;
        return;
    }
    content.innerHTML = `\n    <div class="org-catalog">\n      <div class="org-catalog__toolbar" aria-live="polite">\n        <span class="org-catalog__count">${orgCatalogCountLabel(list.length)}</span>\n        <span class="org-catalog__hint">Выберите действие в карточке</span>\n      </div>\n      <div class="org-catalog__list">\n        ${list.map(org => renderOrganizationCardSimple(org)).join("")}\n      </div>\n    </div>`;
}

function displayPartners(organizations, source = "database") {
    const skeleton = document.getElementById("partnersSkeleton");
    const content = document.getElementById("partnersContent");
    if (!skeleton || !content) {
        return;
    }
    const list = organizations.filter(isPartnersSectionOrg);
    skeleton.classList.add("hidden");
    content.classList.remove("hidden");
    if (organizations.length === 0) {
        content.innerHTML = `\n      <div class="empty">\n        <div class="empty-icon"></div>\n        <div class="empty-title">Нет данных</div>\n        <div class="empty-text">На платформе пока нет других компаний</div>\n      </div>\n    `;
        return;
    }
    if (list.length === 0) {
        content.innerHTML = `\n      <div class="empty">\n        <div class="empty-icon"></div>\n        <div class="empty-title">Пока нет партнёрств</div>\n        <div class="empty-text">Запросите партнёрство в разделе «Организации» — после этого карточка появится здесь.</div>\n      </div>\n    `;
        return;
    }
    content.innerHTML = list.map(org => renderPartnerCard(org)).join("");
}

async function createPartnershipByBin(bin) {
    if (typeof showError === "function") {
        showError("Для заключения партнерства компания должна быть зарегистрирована на платформе. Попросите представителя компании зарегистрироваться через ЭЦП.");
    } else {
        alert("Для заключения партнерства компания должна быть зарегистрирована на платформе. Попросите представителя компании зарегистрироваться через ЭЦП.");
    }
}

function closePartnershipConfirmModal() {
    const modal = document.getElementById("partnershipConfirmModal");
    if (modal) {
        modal.style.display = "none";
        delete modal.dataset.companyId;
    }
}

function openPartnershipConfirmModal(companyId) {
    const modal = document.getElementById("partnershipConfirmModal");
    if (!modal) {
        return;
    }
    modal.dataset.companyId = String(companyId);
    modal.style.display = "flex";
}

function createPartnership(companyId) {
    openPartnershipConfirmModal(companyId);
}

async function submitPartnershipRequest() {
    const modal = document.getElementById("partnershipConfirmModal");
    const idStr = modal && modal.dataset.companyId;
    const companyId = idStr ? parseInt(idStr, 10) : NaN;
    if (!Number.isFinite(companyId)) {
        closePartnershipConfirmModal();
        return;
    }
    closePartnershipConfirmModal();
    try {
        const response = await fetch(organizationsApiUrl("/partnerships"), {
            method: "POST",
            headers: orgApiHeaders(),
            body: JSON.stringify({
                company2_id: companyId
            })
        });
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.detail || "Ошибка создания партнерства");
        }
        await response.json();
        if (typeof showSuccess === "function") {
            showSuccess("Запрос отправлен. Подписание договора — в разделе «Партнёры».");
        }
        await loadOrganizations(currentOrganizationSource);
    } catch (error) {
        console.error("Ошибка создания партнерства:", error);
        if (typeof showError === "function") {
            showError(error.message);
        }
    }
}

function revokePartnershipAgreementBlobUrl() {
    const frame = document.getElementById("partnershipAgreementIframe");
    if (frame && frame.dataset.blobUrl) {
        try {
            URL.revokeObjectURL(frame.dataset.blobUrl);
        } catch (e) {}
        delete frame.dataset.blobUrl;
        frame.removeAttribute("src");
    }
}

function closePartnershipAgreementModal(options = {}) {
    const modal = document.getElementById("partnershipAgreementModal");
    if (modal) modal.style.display = "none";
    revokePartnershipAgreementBlobUrl();
    const ack = document.getElementById("partnershipAgreementAck");
    const signBtn = document.getElementById("partnershipAgreementSignBtn");
    if (ack) ack.checked = false;
    if (signBtn) signBtn.disabled = true;
    const refreshOrgs = options.refreshOrgs !== false;
    if (refreshOrgs && (document.body.classList.contains("page-organizations") || document.body.classList.contains("page-partners"))) {
        void loadOrganizations(currentOrganizationSource, {
            skipSkeleton: true
        });
    }
}

function closeOrgEgovRegistryModal() {
    const modal = document.getElementById("orgEgovRegistryModal");
    if (modal) modal.style.display = "none";
    if (document.body.classList.contains("page-organizations") || document.body.classList.contains("page-partners")) {
        void loadOrganizations(currentOrganizationSource, {
            skipSkeleton: true
        });
    }
}

function openOrgEgovRegistryNoBinModal() {
    const modal = document.getElementById("orgEgovRegistryModal");
    const loading = document.getElementById("orgEgovRegistryLoading");
    const errorEl = document.getElementById("orgEgovRegistryError");
    const gridWrap = document.getElementById("orgEgovRegistryData");
    const grid = document.getElementById("orgEgovRegistryGrid");
    const infoEl = document.getElementById("orgEgovRegistryInfo");
    const infoText = document.getElementById("orgEgovRegistryInfoText");
    if (!modal) return;
    grid.innerHTML = "";
    if (loading) loading.style.display = "none";
    if (errorEl) errorEl.style.display = "none";
    if (gridWrap) gridWrap.style.display = "none";
    if (infoText) {
        infoText.textContent = "Сведения из реестра юрлиц (data.egov.kz) запрашиваются по БИН организации — 12 цифр. Если контрагент зарегистрирован по ИИН или в профиле не указан БИН, карточку компании из этого реестра показать нельзя.";
    }
    if (infoEl) infoEl.style.display = "block";
    modal.style.display = "flex";
}

async function openOrgEgovRegistryModal(bin) {
    const modal = document.getElementById("orgEgovRegistryModal");
    const loading = document.getElementById("orgEgovRegistryLoading");
    const errorEl = document.getElementById("orgEgovRegistryError");
    const errorText = document.getElementById("orgEgovRegistryErrorText");
    const gridWrap = document.getElementById("orgEgovRegistryData");
    const grid = document.getElementById("orgEgovRegistryGrid");
    const infoEl = document.getElementById("orgEgovRegistryInfo");
    if (!modal || !grid) return;
    grid.innerHTML = "";
    if (infoEl) infoEl.style.display = "none";
    if (loading) loading.style.display = "block";
    if (errorEl) errorEl.style.display = "none";
    if (gridWrap) gridWrap.style.display = "none";
    if (errorText) errorText.textContent = "";
    modal.style.display = "flex";
    try {
        const headers = orgApiHeaders();
        const res = await fetch(`${getApiBase()}/api/egov/company/${encodeURIComponent(bin)}`, {
            method: "GET",
            headers: headers
        });
        let data = {};
        try {
            data = await res.json();
        } catch (parseErr) {
            throw new Error("Некорректный ответ сервера");
        }
        if (!res.ok) {
            throw new Error(data.detail || "Ошибка " + res.status);
        }
        if (data.success && data.data) {
            if (typeof renderEgovCompanyGridHTML !== "function") {
                throw new Error("Не загружен модуль отображения (egov-company-display.js)");
            }
            grid.innerHTML = renderEgovCompanyGridHTML(data.data);
            if (gridWrap) gridWrap.style.display = "block";
        } else {
            throw new Error("Данные не получены");
        }
    } catch (e) {
        console.error(e);
        if (errorText) errorText.textContent = e.message || "Ошибка загрузки";
        if (errorEl) errorEl.style.display = "block";
    } finally {
        if (loading) loading.style.display = "none";
    }
}

async function openPartnershipAgreementModal(partnershipId, allowSign) {
    revokePartnershipAgreementBlobUrl();
    const modal = document.getElementById("partnershipAgreementModal");
    const footer = document.getElementById("partnershipAgreementSignFooter");
    const ack = document.getElementById("partnershipAgreementAck");
    const signBtn = document.getElementById("partnershipAgreementSignBtn");
    const frame = document.getElementById("partnershipAgreementIframe");
    if (!modal || !footer || !frame) {
        if (typeof showError === "function") showError("Не найдено окно договора. Обновите страницу.");
        return;
    }
    footer.style.display = allowSign ? "flex" : "none";
    if (ack) ack.checked = false;
    if (signBtn) {
        signBtn.disabled = true;
        signBtn.dataset.partnershipId = String(partnershipId);
    }
    modal.dataset.partnershipId = String(partnershipId);
    modal.dataset.allowSign = allowSign ? "1" : "0";
    modal.style.display = "flex";
    try {
        const res = await fetch(organizationsApiUrl(`/partnerships/${partnershipId}/agreement`), {
            headers: orgApiHeaders()
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || "Не удалось загрузить текст договора");
        }
        const html = await res.text();
        const blob = new Blob([ html ], {
            type: "text/html;charset=utf-8"
        });
        const url = URL.createObjectURL(blob);
        frame.dataset.blobUrl = url;
        frame.src = url;
        markPartnershipContractSeen(partnershipId);
    } catch (e) {
        console.error(e);
        if (typeof showError === "function") showError(e.message || "Ошибка загрузки договора");
        closePartnershipAgreementModal();
    }
}

async function signPartnership(partnershipId) {
    if (_partnershipSignInProgress) {
        return;
    }
    _partnershipSignInProgress = true;
    const pactSignBtn = document.getElementById("partnershipAgreementSignBtn");
    if (pactSignBtn) pactSignBtn.disabled = true;
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
                    } else if (attempts > 50) {
                        clearInterval(checkInterval);
                        reject(new Error("NCALayer не загружен. Обновите страницу."));
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
        if (typeof NCALayerClient === "undefined") {
            throw new Error("NCALayer не загружен. Обновите страницу.");
        }
        const nonceResponse = await fetch(organizationsApiUrl(`/partnerships/${partnershipId}/sign-nonce`), {
            headers: orgApiHeaders()
        });
        if (!nonceResponse.ok) {
            const error = await nonceResponse.json();
            throw new Error(error.detail || "Ошибка получения nonce");
        }
        const {nonce: nonce} = await nonceResponse.json();
        const client = new NCALayerClient;
        await client.connect();
        const xmlToSign = `<?xml version="1.0" encoding="UTF-8"?><partnership>${nonce}</partnership>`;
        if (typeof showSuccess === "function") {
            showSuccess("Подписание договора партнёрства… Подтвердите действие в окне NCALayer.");
        }
        const signedXml = await client.signXml("PKCS12", xmlToSign);
        const verifyResponse = await fetch(organizationsApiUrl(`/partnerships/${partnershipId}/verify-signature`), {
            method: "POST",
            headers: orgApiHeaders(),
            body: JSON.stringify({
                signed_xml: signedXml,
                nonce: nonce
            })
        });
        if (!verifyResponse.ok) {
            const error = await verifyResponse.json();
            throw new Error(error.detail || "Ошибка верификации подписи");
        }
        const partnership = await verifyResponse.json();
        if (typeof showSuccess === "function") {
            if (partnership.status === "signed") {
                showSuccess("Договор партнерства подписан обеими сторонами! Теперь вы можете участвовать в аукционах этой компании.");
            } else {
                showSuccess("Ваша подпись добавлена. Ожидайте подписания второй стороной.");
            }
        }
        clearPartnershipFlow(partnershipId);
        closePartnershipAgreementModal({
            refreshOrgs: false
        });
        await loadOrganizations(currentOrganizationSource);
    } catch (error) {
        console.error("Ошибка подписания договора:", error);
        const msg = error && error.message ? String(error.message) : "Ошибка подписания";
        const hint = /не установлено|NCALayer|подключен/i.test(msg) ? " Запустите приложение NCALayer на компьютере и повторите попытку." : "";
        setPartnershipFlow(partnershipId, {
            signError: msg + hint
        });
        if (typeof showError === "function") {
            showError(msg + hint);
        }
        await loadOrganizations(currentOrganizationSource);
    } finally {
        _partnershipSignInProgress = false;
        const btn = document.getElementById("partnershipAgreementSignBtn");
        const ack = document.getElementById("partnershipAgreementAck");
        if (btn && ack) btn.disabled = !ack.checked;
    }
}

async function viewPartnership(partnershipId) {
    await openPartnershipAgreementModal(partnershipId, false);
}

let currentOrganizationSource = "database";

function switchOrganizationSource(source) {
    return;
}

function getInitialPageFromHash() {
    const raw = (window.location.hash || "").replace(/^#/, "");
    if (!raw) return null;
    if (raw.toLowerCase().startsWith("request-")) return "requests";
    const h = raw.toLowerCase();
    if (h === "organizations") return "organizations";
    if (h === "partners") return "partners";
    if (h === "requests") return "requests";
    return null;
}

function setNavHashForPage(page) {
    if (typeof history === "undefined" || !history.replaceState) return;
    const base = window.location.pathname + window.location.search;
    const hash = page === "requests" ? "" : `#${page}`;
    history.replaceState(null, "", base + hash);
}

function syncBodyPageMode(page) {
    document.body.classList.remove("page-requests", "page-organizations", "page-partners");
    if (page === "organizations") {
        document.body.classList.add("page-organizations");
    } else if (page === "partners") {
        document.body.classList.add("page-partners");
    } else {
        document.body.classList.add("page-requests");
    }
}

function switchPage(page) {
    console.log("Переключение на страницу:", page);
    const mainContent = document.getElementById("mainContent");
    const organizationsSection = document.getElementById("organizationsSection");
    const partnersSection = document.getElementById("partnersSection");
    if (!mainContent || !organizationsSection || !partnersSection) {
        console.error("Секции не найдены!");
        return;
    }
    const navItems = document.querySelectorAll(".nav-item[data-page]");
    navItems.forEach(item => {
        if (item.dataset.page === page) {
            item.classList.add("active");
        } else {
            item.classList.remove("active");
        }
    });
    if (page === "requests") {
        mainContent.classList.add("page-visible");
        mainContent.classList.remove("page-hidden");
        organizationsSection.classList.add("page-hidden");
        organizationsSection.classList.remove("page-visible");
        partnersSection.classList.add("page-hidden");
        partnersSection.classList.remove("page-visible");
        syncBodyPageMode("requests");
    } else if (page === "organizations") {
        organizationsSection.classList.add("page-visible");
        organizationsSection.classList.remove("page-hidden");
        partnersSection.classList.add("page-hidden");
        partnersSection.classList.remove("page-visible");
        mainContent.classList.add("page-hidden");
        mainContent.classList.remove("page-visible");
        syncBodyPageMode("organizations");
        setTimeout(() => {
            loadOrganizations("database");
        }, 100);
    } else if (page === "partners") {
        partnersSection.classList.add("page-visible");
        partnersSection.classList.remove("page-hidden");
        organizationsSection.classList.add("page-hidden");
        organizationsSection.classList.remove("page-visible");
        mainContent.classList.add("page-hidden");
        mainContent.classList.remove("page-visible");
        syncBodyPageMode("partners");
        setTimeout(() => {
            loadOrganizations("database");
        }, 100);
    }
}

document.addEventListener("DOMContentLoaded", () => {
    const navItems = document.querySelectorAll(".nav-item[data-page]");
    navItems.forEach(item => {
        item.addEventListener("click", e => {
            e.preventDefault();
            const page = item.dataset.page;
            switchPage(page);
            setNavHashForPage(page);
        });
    });
    function handleOrgPartnersClick(e) {
        const button = e.target.closest("button[data-action]");
        if (!button) return;
        const action = button.dataset.action;
        const orgId = button.dataset.orgId;
        const partnershipId = button.dataset.partnershipId;
        const egovBin = button.dataset.bin;
        if (action === "egov-registry") {
            if (partnershipId) {
                markPartnershipRegistrySeen(parseInt(partnershipId, 10));
            }
            const bin = (egovBin || "").trim();
            if (bin && typeof isValidEgovBin === "function" && isValidEgovBin(bin)) {
                openOrgEgovRegistryModal(bin);
            } else {
                openOrgEgovRegistryNoBinModal();
            }
            return;
        }
        if (action === "clear-partnership-error" && partnershipId) {
            setPartnershipFlow(parseInt(partnershipId, 10), {
                signError: null
            });
            void loadOrganizations(currentOrganizationSource);
            return;
        }
        if (action === "create" && orgId) {
            createPartnership(parseInt(orgId));
        } else if (action === "sign" && partnershipId) {
            openPartnershipAgreementModal(parseInt(partnershipId), true);
        } else if (action === "agreement" && partnershipId) {
            openPartnershipAgreementModal(parseInt(partnershipId), false);
        } else if (action === "view" && partnershipId) {
            viewPartnership(parseInt(partnershipId));
        }
    }
    const organizationsContent = document.getElementById("organizationsContent");
    if (organizationsContent) {
        organizationsContent.addEventListener("click", handleOrgPartnersClick);
    }
    const partnersContent = document.getElementById("partnersContent");
    if (partnersContent) {
        partnersContent.addEventListener("click", handleOrgPartnersClick);
    }
    const pactModal = document.getElementById("partnershipAgreementModal");
    if (pactModal) {
        pactModal.addEventListener("click", e => {
            if (e.target === pactModal) closePartnershipAgreementModal();
        });
    }
    const pactClose = document.getElementById("partnershipAgreementCloseBtn");
    if (pactClose) pactClose.addEventListener("click", closePartnershipAgreementModal);
    const orgEgovModal = document.getElementById("orgEgovRegistryModal");
    if (orgEgovModal) {
        orgEgovModal.addEventListener("click", e => {
            if (e.target === orgEgovModal) closeOrgEgovRegistryModal();
        });
    }
    const orgEgovClose = document.getElementById("orgEgovRegistryCloseBtn");
    const orgEgovOk = document.getElementById("orgEgovRegistryOkBtn");
    if (orgEgovClose) orgEgovClose.addEventListener("click", closeOrgEgovRegistryModal);
    if (orgEgovOk) orgEgovOk.addEventListener("click", closeOrgEgovRegistryModal);
    const pactConfirmModal = document.getElementById("partnershipConfirmModal");
    if (pactConfirmModal) {
        pactConfirmModal.addEventListener("click", e => {
            if (e.target === pactConfirmModal) closePartnershipConfirmModal();
        });
    }
    const pactConfirmClose = document.getElementById("partnershipConfirmCloseBtn");
    const pactConfirmCancel = document.getElementById("partnershipConfirmCancelBtn");
    const pactConfirmOk = document.getElementById("partnershipConfirmOkBtn");
    if (pactConfirmClose) pactConfirmClose.addEventListener("click", closePartnershipConfirmModal);
    if (pactConfirmCancel) pactConfirmCancel.addEventListener("click", closePartnershipConfirmModal);
    if (pactConfirmOk) pactConfirmOk.addEventListener("click", () => submitPartnershipRequest());
    const pactAck = document.getElementById("partnershipAgreementAck");
    const pactSignBtn = document.getElementById("partnershipAgreementSignBtn");
    if (pactAck && pactSignBtn) {
        pactAck.addEventListener("change", () => {
            pactSignBtn.disabled = !pactAck.checked;
        });
        pactSignBtn.addEventListener("click", async () => {
            const id = pactSignBtn.dataset.partnershipId;
            if (!id) return;
            if (!pactAck.checked) {
                if (typeof showInfo === "function") showInfo("Отметьте, что вы ознакомились с текстом договора.");
                return;
            }
            await signPartnership(parseInt(id, 10));
        });
    }
    const hashPage = getInitialPageFromHash();
    if (hashPage) {
        document.querySelectorAll(".nav-item[data-page]").forEach(n => {
            n.classList.toggle("active", n.dataset.page === hashPage);
        });
        switchPage(hashPage);
    } else {
        const activeNavItem = document.querySelector(".nav-item.active");
        if (activeNavItem && activeNavItem.dataset.page) {
            const activePage = activeNavItem.dataset.page;
            switchPage(activePage);
        } else {
            const requestsNavItem = document.querySelector('.nav-item[data-page="requests"]');
            if (requestsNavItem) {
                requestsNavItem.classList.add("active");
                switchPage("requests");
            }
        }
    }
});

window.loadOrganizations = loadOrganizations;

window.createPartnership = createPartnership;

window.createPartnershipByBin = createPartnershipByBin;

window.submitPartnershipRequest = submitPartnershipRequest;

window.closePartnershipConfirmModal = closePartnershipConfirmModal;

window.openPartnershipConfirmModal = openPartnershipConfirmModal;

window.signPartnership = signPartnership;

window.viewPartnership = viewPartnership;

window.openPartnershipAgreementModal = openPartnershipAgreementModal;

window.closePartnershipAgreementModal = closePartnershipAgreementModal;

window.closeOrgEgovRegistryModal = closeOrgEgovRegistryModal;

window.openOrgEgovRegistryModal = openOrgEgovRegistryModal;

window.openOrgEgovRegistryNoBinModal = openOrgEgovRegistryNoBinModal;

window.switchPage = switchPage;

window.switchOrganizationSource = switchOrganizationSource;

window.displayPartners = displayPartners;