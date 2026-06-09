const API_URL_EGOV = typeof API_URL !== "undefined" ? API_URL : "https://cargoaitulogistic.onrender.com";

let egovCompanyData = null;

async function loadEgovCompanyData(bin) {
    const egovSection = document.getElementById("egovCompanySection");
    const egovData = document.getElementById("egovCompanyData");
    const egovError = document.getElementById("egovCompanyError");
    const egovLoading = document.getElementById("egovCompanyLoading");
    const egovGrid = document.getElementById("egovCompanyGrid");
    const errorText = document.getElementById("egovErrorText");
    if (!egovSection) return;
    if (!bin || bin.length !== 12 || !/^\d{12}$/.test(bin)) {
        egovSection.style.display = "block";
        egovData.style.display = "none";
        egovError.style.display = "block";
        egovLoading.style.display = "none";
        if (errorText) {
            errorText.textContent = "БИН должен содержать 12 цифр. Укажите БИН в платёжных реквизитах.";
        }
        return;
    }
    egovSection.style.display = "block";
    egovData.style.display = "none";
    egovError.style.display = "none";
    egovLoading.style.display = "block";
    try {
        const user = JSON.parse(localStorage.getItem("user") || "{}");
        const userId = user.id;
        if (!userId) {
            throw new Error("Необходимо войти в систему");
        }
        const response = await fetch(`${API_URL_EGOV}/api/egov/company/${bin}`, {
            method: "GET",
            headers: {
                "Content-Type": "application/json",
                "X-User-Id": userId.toString()
            }
        });
        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.detail || "Ошибка при получении данных");
        }
        if (data.success && data.data) {
            egovCompanyData = data.data;
            displayEgovCompanyData(data.data);
            egovData.style.display = "block";
            egovError.style.display = "none";
            if (typeof autofillPaymentDetailsFromCompany === "function") {
                autofillPaymentDetailsFromCompany(data.data);
            }
        } else {
            throw new Error("Данные не получены");
        }
    } catch (error) {
        console.error("Ошибка загрузки данных из data.egov.kz:", error);
        egovData.style.display = "none";
        egovError.style.display = "block";
        if (errorText) {
            const user = JSON.parse(localStorage.getItem("user") || "{}");
            if (user.iin && bin === user.iin) {
                errorText.textContent = "Для проверки компании необходим БИН (12 цифр), а не ИИН. Укажите БИН в платёжных реквизитах.";
            } else {
                errorText.textContent = error.message || "Не удалось загрузить данные";
            }
        }
    } finally {
        egovLoading.style.display = "none";
    }
}

function displayEgovCompanyData(company) {
    const egovGrid = document.getElementById("egovCompanyGrid");
    if (!egovGrid) return;
    if (typeof renderEgovCompanyGridHTML !== "function") {
        console.error("renderEgovCompanyGridHTML не найдена. Подключите egov-company-display.js перед egov-company.js");
        return;
    }
    egovGrid.innerHTML = renderEgovCompanyGridHTML(company);
}

function initEgovCompany() {
    const egovSection = document.getElementById("egovCompanySection");
    const user = JSON.parse(localStorage.getItem("user") || "{}");
    if (egovSection && user.id) {
        egovSection.style.display = "block";
    }
    const loadBtn = document.getElementById("loadEgovDataBtn");
    if (loadBtn) {
        loadBtn.addEventListener("click", async () => {
            const paymentIIN2 = document.getElementById("paymentIIN");
            const user2 = JSON.parse(localStorage.getItem("user") || "{}");
            let bin = null;
            if (user2.bin && /^\d{12}$/.test(user2.bin)) {
                bin = user2.bin;
            } else if (paymentIIN2 && paymentIIN2.textContent && paymentIIN2.textContent !== "—" && paymentIIN2.textContent !== "Не указан") {
                bin = paymentIIN2.textContent.trim();
                if (user2.iin && bin === user2.iin) {
                    bin = null;
                }
            }
            if (bin && /^\d{12}$/.test(bin)) {
                await loadEgovCompanyData(bin);
            } else {
                console.log("БИН не указан в платёжных реквизитах. Укажите БИН для проверки компании.");
            }
        });
    }
    const paymentIIN = document.getElementById("paymentIIN");
    if (paymentIIN) {
        const observer = new MutationObserver(() => {
            const bin = paymentIIN.textContent.trim();
            if (bin && bin !== "—" && bin !== "Не указан" && /^\d{12}$/.test(bin)) {
                const user2 = JSON.parse(localStorage.getItem("user") || "{}");
                if (user2.bin && bin === user2.bin) {
                    setTimeout(() => {
                        loadEgovCompanyData(bin);
                    }, 500);
                } else if (!user2.iin || bin !== user2.iin) {
                    setTimeout(() => {
                        loadEgovCompanyData(bin);
                    }, 500);
                }
            }
        });
        observer.observe(paymentIIN, {
            childList: true,
            characterData: true,
            subtree: true
        });
    }
}

window.showEgovCompanySection = async function() {
    const dropdown = document.getElementById("userProfileDropdown");
    if (dropdown) {
        dropdown.style.display = "none";
    }
    if (typeof loadPaymentDetails === "function") {
        try {
            await loadPaymentDetails();
        } catch (e) {
            console.warn("Не удалось загрузить платёжные реквизиты:", e);
        }
    }
    const userSection = document.getElementById("userSection");
    if (userSection) {
        userSection.style.display = "block";
        const egovSection = document.getElementById("egovCompanySection");
        if (egovSection) {
            egovSection.style.display = "block";
            setTimeout(() => {
                egovSection.scrollIntoView({
                    behavior: "smooth",
                    block: "nearest"
                });
            }, 100);
            const paymentIIN = document.getElementById("paymentIIN");
            const user = JSON.parse(localStorage.getItem("user") || "{}");
            let bin = null;
            if (user.bin && /^\d{12}$/.test(user.bin)) {
                bin = user.bin;
            } else if (paymentIIN && paymentIIN.textContent && paymentIIN.textContent !== "—" && paymentIIN.textContent !== "Не указан") {
                bin = paymentIIN.textContent.trim();
                if (user.iin && bin === user.iin) {
                    bin = null;
                }
            }
            if (bin && /^\d{12}$/.test(bin) && (!user.iin || bin !== user.iin)) {
                loadEgovCompanyData(bin);
            }
        }
    }
};

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initEgovCompany);
} else {
    initEgovCompany();
}