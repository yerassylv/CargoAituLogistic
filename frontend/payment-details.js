const API_URL_PAYMENT = typeof API_URL !== "undefined" ? API_URL : "https://cargoaitulogistic.onrender.com";

let currentUserId = null;

let lastMissingPaymentFields = [];

const KZ_BANK_BY_BIK = {
    125000036: "АО «Народный Банк Казахстана»",
    125000011: "АО «Kaspi Bank»",
    722000011: "АО «Банк ЦентрКредит»",
    125000005: "АО «First Heartland Jýsan Bank»",
    125000023: "АО «ForteBank»"
};

const PAYMENT_FIELD_ORDER = [ "recipientName", "bankName", "bankBIK", "bankAccount", "bankCorrAccount", "kpp", "paymentCurrencySelect", "address", "directorName", "accountantName" ];

function stripKzIban(s) {
    return (s || "").replace(/\s/g, "").toUpperCase().replace(/[^KZ0-9]/gi, "");
}

function normalizeKzIban(input) {
    let raw = stripKzIban(input);
    if (!raw.startsWith("KZ")) {
        const digits = raw.replace(/\D/g, "");
        raw = "KZ" + digits.slice(0, 18);
    } else {
        raw = "KZ" + raw.slice(2).replace(/\D/g, "").slice(0, 18);
    }
    return raw.length > 20 ? raw.slice(0, 20) : raw;
}

function formatKzIbanDisplay(clean) {
    if (!clean) return "";
    if (!clean.startsWith("KZ")) return clean;
    const d = clean.slice(2).replace(/\D/g, "").slice(0, 18);
    const parts = [];
    for (let i = 0; i < d.length; i += 4) parts.push(d.slice(i, i + 4));
    return "KZ" + (parts.length ? " " + parts.join(" ") : "");
}

function isValidKzIban20(clean) {
    return /^KZ\d{18}$/i.test(clean);
}

function setFieldError(inputEl, message) {
    const err = document.getElementById(`${inputEl.id}Error`);
    const wrap = inputEl.closest(".pd-form__field");
    if (err) err.textContent = message || "";
    if (wrap) {
        wrap.classList.toggle("pd-form__field--invalid", !!message);
        const ok = !message && inputEl.value && inputEl.hasAttribute("required");
        wrap.classList.toggle("pd-form__field--valid", !!ok);
    }
    if (inputEl.setAttribute) {
        if (message) inputEl.setAttribute("aria-invalid", "true"); else inputEl.removeAttribute("aria-invalid");
    }
}

function clearOptionalFieldVisual(inputEl) {
    const wrap = inputEl.closest(".pd-form__field");
    if (wrap) {
        wrap.classList.remove("pd-form__field--invalid", "pd-form__field--valid");
    }
    const err = document.getElementById(`${inputEl.id}Error`);
    if (err) err.textContent = "";
    if (inputEl.removeAttribute) inputEl.removeAttribute("aria-invalid");
}

function validatePaymentField(inputEl) {
    const id = inputEl.id;
    if (id === "recipientName") {
        const v = (inputEl.value || "").trim();
        if (!v) {
            setFieldError(inputEl, "Обязательное поле");
            return false;
        }
        setFieldError(inputEl, "");
        return true;
    }
    if (id === "bankName") {
        const v = (inputEl.value || "").trim();
        if (!v) {
            setFieldError(inputEl, "Обязательное поле");
            return false;
        }
        setFieldError(inputEl, "");
        return true;
    }
    if (id === "bankBIK") {
        const d = (inputEl.value || "").replace(/\D/g, "").slice(0, 8);
        if (inputEl.value !== d) inputEl.value = d;
        if (d.length === 0) {
            setFieldError(inputEl, "Обязательное поле");
            return false;
        }
        if (d.length !== 8) {
            setFieldError(inputEl, "8 цифр");
            return false;
        }
        setFieldError(inputEl, "");
        return true;
    }
    if (id === "bankAccount") {
        const clean = normalizeKzIban(inputEl.value);
        inputEl.value = formatKzIbanDisplay(clean);
        if (!clean || clean === "KZ") {
            setFieldError(inputEl, "Обязательное поле");
            return false;
        }
        if (!isValidKzIban20(clean)) {
            setFieldError(inputEl, "KZ + 18 цифр");
            return false;
        }
        setFieldError(inputEl, "");
        return true;
    }
    clearOptionalFieldVisual(inputEl);
    return true;
}

function validatePaymentFormAll() {
    const ids = [ "recipientName", "bankName", "bankBIK", "bankAccount" ];
    let ok = true;
    ids.forEach(fid => {
        const el = document.getElementById(fid);
        if (el && !validatePaymentField(el)) ok = false;
    });
    return ok;
}

function bindPaymentFormHandlers() {
    const form = document.getElementById("paymentDetailsForm");
    if (!form || form.dataset.bound === "1") return;
    form.dataset.bound = "1";
    form.addEventListener("input", e => {
        const t = e.target;
        if (t.id === "bankBIK") {
            t.value = t.value.replace(/\D/g, "").slice(0, 8);
            if (t.value.length === 8) {
                const acc = document.getElementById("bankAccount");
                if (acc) requestAnimationFrame(() => acc.focus());
            }
        }
        if (t.id === "bankAccount") {
            const clean = normalizeKzIban(t.value);
            t.value = formatKzIbanDisplay(clean);
            try {
                t.setSelectionRange(t.value.length, t.value.length);
            } catch (_) {}
        }
    });
    form.addEventListener("blur", e => {
        const t = e.target;
        if (t.matches("#paymentDetailsForm input")) {
            validatePaymentField(t);
        }
        if (t.id === "bankBIK") {
            const d = (t.value || "").replace(/\D/g, "");
            if (d.length === 8) {
                const hint = KZ_BANK_BY_BIK[d];
                const bankName = document.getElementById("bankName");
                if (hint && bankName && !bankName.value.trim()) {
                    bankName.value = hint;
                    validatePaymentField(bankName);
                }
            }
        }
    }, true);
    form.addEventListener("keydown", e => {
        if (e.target.id === "bankBIK") {
            const ctrl = e.ctrlKey || e.metaKey || e.altKey;
            if (!ctrl && e.key.length === 1 && !/\d/.test(e.key)) {
                e.preventDefault();
            }
        }
        if (e.key !== "Enter") return;
        if (e.target.tagName === "TEXTAREA") return;
        if (!e.target.matches("#paymentDetailsForm input, #paymentDetailsForm select")) return;
        e.preventDefault();
        const idx = PAYMENT_FIELD_ORDER.indexOf(e.target.id);
        if (idx >= 0 && idx < PAYMENT_FIELD_ORDER.length - 1) {
            const next = document.getElementById(PAYMENT_FIELD_ORDER[idx + 1]);
            if (next) next.focus();
        }
    });
}

function applyPaymentFormAutofillHints(user) {
    if (!user) return;
    const recipientEl = document.getElementById("recipientName");
    if (recipientEl && !recipientEl.value.trim() && user.company_name) {
        recipientEl.value = user.company_name;
    }
}

window.openPaymentDetailsModal = async function() {
    const modal = document.getElementById("paymentDetailsModal");
    if (!modal) {
        console.error("Модальное окно paymentDetailsModal не найдено");
        return;
    }
    bindPaymentFormHandlers();
    modal.style.display = "flex";
    if (typeof lockBodyScroll === "function") {
        lockBodyScroll();
    }
    const userData = localStorage.getItem("user");
    const user = userData ? JSON.parse(userData) : null;
    if (typeof loadPaymentDetailsForEdit === "function") {
        await loadPaymentDetailsForEdit();
    }
    if (user) applyPaymentFormAutofillHints(user);
    const first = document.getElementById("recipientName");
    if (first) {
        setTimeout(() => {
            try {
                first.focus({
                    preventScroll: false
                });
            } catch (e) {
                first.focus();
            }
        }, 50);
    }
};

async function loadPaymentDetails() {
    try {
        const userData = localStorage.getItem("user");
        if (!userData) return;
        const user = JSON.parse(userData);
        currentUserId = user.id;
        const paymentSection = document.getElementById("paymentDetailsSection");
        if (!paymentSection) {
            return;
        }
        paymentSection.style.display = "block";
        try {
            const details = await apiFetch(`${API_URL_PAYMENT}/api/users/${user.id}/payment-details`);
            const updateField = (id, value, isEmpty = false) => {
                const field = document.getElementById(id);
                if (field) {
                    field.textContent = value || (isEmpty ? "—" : "Не указан");
                    if (isEmpty || !value) {
                        field.classList.add("empty");
                    } else {
                        field.classList.remove("empty");
                    }
                }
            };
            updateField("paymentRecipient", details.recipient_name, true);
            updateField("paymentIIN", details.iin || user.iin, true);
            updateField("paymentBankName", details.bank_name);
            updateField("paymentBIK", details.bank_bik);
            updateField("paymentAccount", details.bank_account);
            updateField("paymentCorrAccount", details.bank_corr_account, true);
            updateField("paymentKPP", details.kpp, true);
            const paymentCurrencyDisplay = document.getElementById("paymentCurrencyDisplay");
            if (paymentCurrencyDisplay) {
                paymentCurrencyDisplay.textContent = details.payment_currency || "KZT";
                paymentCurrencyDisplay.classList.remove("empty");
            }
        } catch (error) {
            console.log("Реквизиты еще не заполнены или ошибка загрузки:", error);
            const setEmptyField = (id, isEmpty = false) => {
                const field = document.getElementById(id);
                if (field) {
                    field.textContent = isEmpty ? "—" : "Не указан";
                    field.classList.add("empty");
                }
            };
            setEmptyField("paymentRecipient", true);
            setEmptyField("paymentIIN", true);
            setEmptyField("paymentBankName");
            setEmptyField("paymentBIK");
            setEmptyField("paymentAccount");
            setEmptyField("paymentCorrAccount", true);
            setEmptyField("paymentKPP", true);
            const paymentCurrencyDisplay = document.getElementById("paymentCurrencyDisplay");
            if (paymentCurrencyDisplay) {
                paymentCurrencyDisplay.textContent = "KZT";
                paymentCurrencyDisplay.classList.remove("empty");
            }
            const paymentIIN = document.getElementById("paymentIIN");
            if (paymentIIN && user.iin) {
                paymentIIN.textContent = user.iin;
                paymentIIN.classList.remove("empty");
            }
        }
    } catch (error) {
        console.error("Ошибка при загрузке реквизитов:", error);
        const paymentSection = document.getElementById("paymentDetailsSection");
        if (paymentSection) {
            paymentSection.style.display = "block";
        }
    }
}

async function loadPaymentDetailsForEdit() {
    const userData = localStorage.getItem("user");
    if (!userData) return;
    const user = JSON.parse(userData);
    const setVal = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.value = val || "";
    };
    try {
        const details = await apiFetch(`${API_URL_PAYMENT}/api/users/${user.id}/payment-details`);
        setVal("recipientName", details.recipient_name);
        setVal("bankName", details.bank_name);
        setVal("bankBIK", details.bank_bik ? String(details.bank_bik).replace(/\D/g, "").slice(0, 8) : "");
        const acc = details.bank_account ? normalizeKzIban(details.bank_account) : "";
        const accEl = document.getElementById("bankAccount");
        if (accEl) accEl.value = acc ? formatKzIbanDisplay(acc) : "";
        setVal("bankCorrAccount", details.bank_corr_account);
        setVal("kpp", details.kpp);
        const cur = document.getElementById("paymentCurrencySelect");
        if (cur) cur.value = details.payment_currency || "KZT";
        setVal("address", details.address);
        setVal("directorName", details.director_name);
        setVal("accountantName", details.accountant_name);
        [ "recipientName", "bankName", "bankBIK", "bankAccount" ].forEach(fid => {
            const el = document.getElementById(fid);
            if (el) setFieldError(el, "");
        });
    } catch (error) {
        console.error("Ошибка при загрузке реквизитов для редактирования:", error);
    }
}

function closePaymentDetailsModal() {
    const modal = document.getElementById("paymentDetailsModal");
    if (modal) {
        modal.style.display = "none";
        if (typeof unlockBodyScroll === "function") {
            unlockBodyScroll();
        }
    }
}

function resolveBinForPayment(user) {
    const u = user || {};
    if (u.bin && /^\d{12}$/.test(String(u.bin).trim())) return String(u.bin).trim();
    if (u.iin && /^\d{12}$/.test(String(u.iin).trim())) return String(u.iin).trim();
    const paymentIIN = document.getElementById("paymentIIN");
    if (paymentIIN && paymentIIN.textContent) {
        const t = paymentIIN.textContent.trim();
        if (/^\d{12}$/.test(t)) return t;
    }
    return null;
}

async function savePaymentDetails() {
    try {
        const userData = localStorage.getItem("user");
        if (!userData) return;
        const user = JSON.parse(userData);
        const form = document.getElementById("paymentDetailsForm");
        if (!validatePaymentFormAll()) {
            return;
        }
        const bin = resolveBinForPayment(user);
        if (!bin) {
            if (typeof showError === "function") {
                showError("Нужен ИИН или БИН (12 цифр) в профиле или в блоке реквизитов для сохранения.");
            }
            return;
        }
        const bankAccountEl = document.getElementById("bankAccount");
        const bankAccountClean = bankAccountEl ? normalizeKzIban(bankAccountEl.value) : "";
        const bankBikClean = (document.getElementById("bankBIK")?.value || "").replace(/\D/g, "").slice(0, 8);
        const formData = new FormData(form);
        const data = {
            iin: bin,
            recipient_name: (formData.get("recipient_name") || "").trim(),
            bank_name: (formData.get("bank_name") || "").trim(),
            bank_bik: bankBikClean,
            bank_account: bankAccountClean,
            bank_corr_account: formData.get("bank_corr_account") || null,
            kpp: formData.get("kpp") || null,
            payment_currency: formData.get("payment_currency") || "KZT",
            address: formData.get("address") || null,
            director_name: formData.get("director_name") || null,
            accountant_name: formData.get("accountant_name") || null
        };
        await apiFetch(`${API_URL_PAYMENT}/api/users/${user.id}/payment-details`, {
            method: "PUT",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(data)
        });
        if (typeof showSuccess === "function") {
            showSuccess("Реквизиты сохранены");
        }
        closePaymentDetailsModal();
        loadPaymentDetails();
    } catch (error) {
        console.error("Ошибка при сохранении реквизитов:", error);
        if (typeof showError === "function") {
            showError(error.message || "Ошибка при сохранении реквизитов");
        }
    }
}

function showPaymentDetailsRequiredModal(missingFields = []) {
    const modal = document.getElementById("paymentDetailsRequiredModal");
    const missingFieldsList = document.getElementById("missingFieldsList");
    if (!modal || !missingFieldsList) return;
    lastMissingPaymentFields = Array.isArray(missingFields) ? [ ...missingFields ] : [];
    missingFieldsList.innerHTML = "";
    if (lastMissingPaymentFields.length > 0) {
        lastMissingPaymentFields.forEach(label => {
            const li = document.createElement("li");
            li.className = "pd-req-modal__list-item";
            li.textContent = label;
            missingFieldsList.appendChild(li);
        });
    } else {
        const li = document.createElement("li");
        li.className = "pd-req-modal__list-item pd-req-modal__list-item--muted";
        li.textContent = "Обязательные поля в профиле не заполнены";
        missingFieldsList.appendChild(li);
    }
    modal.style.display = "flex";
    if (typeof lockBodyScroll === "function") {
        lockBodyScroll();
    }
}

function closePaymentDetailsRequiredModal() {
    const modal = document.getElementById("paymentDetailsRequiredModal");
    if (modal) {
        modal.style.display = "none";
        if (typeof unlockBodyScroll === "function") {
            unlockBodyScroll();
        }
    }
}

function focusFirstMissingPaymentField() {
    const map = {
        "Получатель": "recipientName",
        "Банк получателя": "bankName",
        "БИК": "bankBIK",
        "Расчётный счёт": "bankAccount"
    };
    const order = [ "Получатель", "Банк получателя", "БИК", "Расчётный счёт" ];
    for (const label of order) {
        if (!lastMissingPaymentFields.includes(label)) continue;
        const id = map[label];
        const el = id && document.getElementById(id);
        if (el) {
            try {
                el.focus({
                    preventScroll: false
                });
            } catch (e) {
                el.focus();
            }
            return;
        }
    }
}

function goToPaymentDetails() {
    closePaymentDetailsRequiredModal();
    if (typeof window.closeRequestDetailModal === "function") {
        window.closeRequestDetailModal();
    }
    if (typeof window.switchPage === "function") {
        window.switchPage("requests");
    }
    if (typeof showUserProfile === "function") {
        showUserProfile();
    }
    setTimeout(() => {
        openPaymentDetailsModal();
        setTimeout(() => focusFirstMissingPaymentField(), 350);
    }, 280);
}

document.addEventListener("DOMContentLoaded", () => {
    bindPaymentFormHandlers();
    const paymentDetailsMenuItem = document.getElementById("paymentDetailsMenuItem");
    if (paymentDetailsMenuItem) {
        paymentDetailsMenuItem.addEventListener("click", e => {
            e.preventDefault();
            if (window.openPaymentDetailsModal) {
                window.openPaymentDetailsModal();
            } else {
                console.error("openPaymentDetailsModal не определена");
            }
        });
    }
    const editBtn = document.getElementById("editPaymentDetailsBtn");
    if (editBtn) {
        editBtn.addEventListener("click", () => {
            if (window.openPaymentDetailsModal) {
                window.openPaymentDetailsModal();
            }
        });
    }
    const saveBtn = document.getElementById("savePaymentDetailsBtn");
    if (saveBtn) {
        saveBtn.addEventListener("click", savePaymentDetails);
    }
    const clearBtn = document.getElementById("clearPaymentDetailsBtn");
    if (clearBtn) {
        clearBtn.addEventListener("click", clearPaymentDetails);
    }
    const goToBtn = document.getElementById("goToPaymentDetailsBtn");
    if (goToBtn) {
        goToBtn.addEventListener("click", goToPaymentDetails);
    }
    [ "paymentDetailsModal", "paymentDetailsRequiredModal" ].forEach(modalId => {
        const modal = document.getElementById(modalId);
        if (modal) {
            modal.addEventListener("click", e => {
                if (e.target === modal) {
                    if (modalId === "paymentDetailsModal") {
                        closePaymentDetailsModal();
                    } else {
                        closePaymentDetailsRequiredModal();
                    }
                }
            });
        }
    });
});

async function clearPaymentDetails() {
    if (!confirm("Очистить все платёжные реквизиты на сервере?")) {
        return;
    }
    try {
        const user = JSON.parse(localStorage.getItem("user") || "{}");
        const response = await fetch(`${API_URL_PAYMENT}/api/users/${user.id}/payment-details`, {
            method: "DELETE",
            headers: {
                "Content-Type": "application/json",
                "X-User-Id": user.id.toString()
            }
        });
        if (!response.ok) {
            const error = await response.json();
            throw new Error(typeof error.detail === "string" ? error.detail : "Ошибка при очистке реквизитов");
        }
        if (typeof showSuccess === "function") {
            showSuccess("Платёжные реквизиты очищены");
        }
        loadPaymentDetails();
        const modal = document.getElementById("paymentDetailsModal");
        if (modal && modal.style.display === "flex") {
            await loadPaymentDetailsForEdit();
        }
    } catch (error) {
        console.error("Ошибка при очистке реквизитов:", error);
        if (typeof showError === "function") {
            showError(error.message || "Ошибка при очистке реквизитов");
        }
    }
}

function autofillPaymentDetailsFromCompany(companyData) {
    if (!companyData) return;
    const recipientNameEl = document.getElementById("recipientName");
    const addressEl = document.getElementById("address");
    const directorNameEl = document.getElementById("directorName");
    if (recipientNameEl && !recipientNameEl.value && companyData.nameru) {
        recipientNameEl.value = companyData.nameru;
    }
    if (addressEl && !addressEl.value && companyData.addressru) {
        addressEl.value = companyData.addressru;
    }
    if (directorNameEl && !directorNameEl.value && companyData.director) {
        directorNameEl.value = companyData.director;
    }
}

window.loadPaymentDetails = loadPaymentDetails;

window.closePaymentDetailsModal = closePaymentDetailsModal;

window.showPaymentDetailsRequiredModal = showPaymentDetailsRequiredModal;

window.closePaymentDetailsRequiredModal = closePaymentDetailsRequiredModal;

window.clearPaymentDetails = clearPaymentDetails;

window.autofillPaymentDetailsFromCompany = autofillPaymentDetailsFromCompany;