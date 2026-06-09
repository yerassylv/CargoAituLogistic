const DRIVERS_API_URL = typeof API_URL !== "undefined" ? API_URL : "https://cargoaitulogistic.onrender.com";

function loadUserData() {
    const userStr = localStorage.getItem("user");
    if (!userStr) {
        return null;
    }
    try {
        return JSON.parse(userStr);
    } catch (e) {
        return null;
    }
}

function getHeaders() {
    const user = loadUserData();
    if (!user || !user.id) {
        throw new Error("Пользователь не авторизован");
    }
    return {
        "Content-Type": "application/json",
        "X-User-Id": user.id.toString()
    };
}

async function loadDrivers() {
    try {
        const response = await fetch(`${DRIVERS_API_URL}/api/drivers`, {
            headers: getHeaders()
        });
        if (!response.ok) {
            throw new Error("Ошибка загрузки водителей");
        }
        const drivers = await response.json();
        displayDrivers(drivers);
    } catch (error) {
        console.error("Ошибка загрузки водителей:", error);
        const tbody = document.getElementById("driversTableBody");
        if (tbody) {
            tbody.innerHTML = `\n        <div class="empty">\n          <div class="empty-icon"></div>\n          <div class="empty-title">Ошибка загрузки</div>\n          <div class="empty-text">${error.message}</div>\n        </div>\n      `;
        }
    }
}

function displayDrivers(drivers) {
    const tbody = document.getElementById("driversTableBody");
    if (!tbody) return;
    if (drivers.length === 0) {
        tbody.innerHTML = `\n      <div class="empty">\n        <div class="empty-icon"></div>\n        <div class="empty-title">Нет водителей</div>\n        <div class="empty-text">Добавьте первого водителя</div>\n      </div>\n    `;
        return;
    }
    tbody.innerHTML = drivers.map(driver => {
        const date = driver.birth_date ? new Date(driver.birth_date).toLocaleDateString("ru-RU") : "-";
        const personnelNumber = driver.personnel_number || "-";
        const hasError = !driver.personnel_number;
        return `\n      <div class="table-row" style="cursor: pointer;" onclick="viewDriver(${driver.id})">\n        <div>${driver.full_name}</div>\n        <div>${date}</div>\n        <div>\n          ${personnelNumber}\n          ${hasError ? '<span style="color: #ef4444; margin-left: 8px;">!</span>' : ""}\n        </div>\n        <div onclick="event.stopPropagation();" style="display: flex; gap: 8px; justify-content: flex-end;">\n          <button class="btn-edit" onclick="event.stopPropagation(); viewDriver(${driver.id})">Просмотр</button>\n          <button class="btn-edit" onclick="event.stopPropagation(); editDriver(${driver.id})">Редактировать</button>\n          <button class="btn-delete" onclick="event.stopPropagation(); deleteDriver(${driver.id}, '${driver.full_name}')">Удалить</button>\n        </div>\n      </div>\n    `;
    }).join("");
}

function openAddDriverModal() {
    const user = loadUserData();
    if (!user) {
        showWarning("Необходимо авторизоваться", "Вход");
        return;
    }
    document.getElementById("addDriverModal").style.display = "flex";
    if (typeof lockBodyScroll === "function") {
        lockBodyScroll();
    }
    document.getElementById("addDriverForm").reset();
    delete document.getElementById("addDriverForm").dataset.driverId;
    document.querySelector("#addDriverModal .modal-header h2").textContent = "Добавление водителя";
}

function closeAddDriverModal() {
    document.getElementById("addDriverModal").style.display = "none";
    if (typeof unlockBodyScroll === "function") {
        unlockBodyScroll();
    }
}

async function submitDriver(event) {
    event.preventDefault();
    try {
        const user = loadUserData();
        if (!user) {
            showWarning("Необходимо авторизоваться", "Вход");
            return;
        }
        const passportSeries = document.getElementById("driverPassportSeries").value.trim() || null;
        const passportNumber = document.getElementById("driverPassportNumber").value.trim() || null;
        const driverData = {
            full_name: document.getElementById("driverFullName").value,
            birth_date: document.getElementById("driverBirthDate").value || null,
            personnel_number: document.getElementById("driverPersonnelNumber").value || null,
            phone: document.getElementById("driverPhone").value || null,
            passport_type: document.getElementById("driverPassportType").value,
            passport_series: passportSeries,
            passport_number: passportNumber,
            passport_issue_date: document.getElementById("driverPassportIssueDate").value || null,
            passport_issued_by: document.getElementById("driverPassportIssuedBy").value || null,
            registration_address: document.getElementById("driverRegistrationAddress").value || null,
            inn: document.getElementById("driverINN").value || null,
            license_type: document.getElementById("driverLicenseType").value || null,
            license_series: document.getElementById("driverLicenseSeries").value || null,
            license_number: document.getElementById("driverLicenseNumber").value || null,
            license_issue_date: document.getElementById("driverLicenseIssueDate").value || null
        };
        if (driverData.birth_date) {
            driverData.birth_date = new Date(driverData.birth_date).toISOString();
        }
        if (driverData.passport_issue_date) {
            driverData.passport_issue_date = new Date(driverData.passport_issue_date).toISOString();
        }
        if (driverData.license_issue_date) {
            driverData.license_issue_date = new Date(driverData.license_issue_date).toISOString();
        }
        const form = document.getElementById("addDriverForm");
        const driverId = form.dataset.driverId;
        const isEdit = !!driverId;
        const url = isEdit ? `${DRIVERS_API_URL}/api/drivers/${driverId}` : `${DRIVERS_API_URL}/api/drivers`;
        const method = isEdit ? "PUT" : "POST";
        const response = await fetch(url, {
            method: method,
            headers: getHeaders(),
            body: JSON.stringify(driverData)
        });
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || `Ошибка ${isEdit ? "обновления" : "создания"} водителя`);
        }
        closeAddDriverModal();
        loadDrivers();
        showSuccess(`Водитель успешно ${isEdit ? "обновлен" : "добавлен"}`);
    } catch (error) {
        console.error("Ошибка:", error);
        showError(error.message);
    }
}

async function deleteDriver(driverId, driverName) {
    if (!confirm(`Вы уверены, что хотите удалить водителя "${driverName}"?`)) {
        return;
    }
    try {
        const response = await fetch(`${DRIVERS_API_URL}/api/drivers/${driverId}`, {
            method: "DELETE",
            headers: getHeaders()
        });
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || "Ошибка удаления водителя");
        }
        loadDrivers();
        showSuccess("Водитель успешно удален");
    } catch (error) {
        console.error("Ошибка удаления водителя:", error);
        showError(error.message);
    }
}

async function editDriver(driverId) {
    try {
        const response = await fetch(`${DRIVERS_API_URL}/api/drivers/${driverId}`, {
            headers: getHeaders()
        });
        if (!response.ok) {
            throw new Error("Ошибка загрузки данных водителя");
        }
        const driver = await response.json();
        document.getElementById("driverFullName").value = driver.full_name || "";
        document.getElementById("driverBirthDate").value = driver.birth_date ? new Date(driver.birth_date).toISOString().split("T")[0] : "";
        document.getElementById("driverPersonnelNumber").value = driver.personnel_number || "";
        document.getElementById("driverPhone").value = driver.phone || "";
        document.getElementById("driverPassportType").value = driver.passport_type || "Казахстан";
        document.getElementById("driverPassportSeries").value = driver.passport_series || "";
        document.getElementById("driverPassportNumber").value = driver.passport_number || "";
        document.getElementById("driverPassportIssueDate").value = driver.passport_issue_date ? new Date(driver.passport_issue_date).toISOString().split("T")[0] : "";
        document.getElementById("driverPassportIssuedBy").value = driver.passport_issued_by || "";
        document.getElementById("driverRegistrationAddress").value = driver.registration_address || "";
        document.getElementById("driverINN").value = driver.inn || "";
        document.getElementById("driverLicenseType").value = driver.license_type || "Казахстан";
        document.getElementById("driverLicenseSeries").value = driver.license_series || "";
        document.getElementById("driverLicenseNumber").value = driver.license_number || "";
        document.getElementById("driverLicenseIssueDate").value = driver.license_issue_date ? new Date(driver.license_issue_date).toISOString().split("T")[0] : "";
        document.getElementById("addDriverForm").dataset.driverId = driverId;
        document.querySelector("#addDriverModal .modal-header h2").textContent = "Редактирование водителя";
        openAddDriverModal();
    } catch (error) {
        console.error("Ошибка загрузки водителя:", error);
        showError(error.message);
    }
}

function initSearch() {
    const searchInput = document.getElementById("driverSearch");
    if (searchInput) {
        searchInput.addEventListener("input", e => {
            console.log("Поиск:", e.target.value);
        });
    }
}

let currentViewDriverId = null;

async function viewDriver(driverId) {
    try {
        currentViewDriverId = driverId;
        const response = await fetch(`${DRIVERS_API_URL}/api/drivers/${driverId}`, {
            headers: getHeaders()
        });
        if (!response.ok) {
            throw new Error("Ошибка загрузки данных водителя");
        }
        const driver = await response.json();
        displayDriverInfo(driver);
        document.getElementById("viewDriverModal").style.display = "flex";
        if (typeof lockBodyScroll === "function") {
            lockBodyScroll();
        }
    } catch (error) {
        console.error("Ошибка загрузки водителя:", error);
        showError(error.message);
    }
}

function displayDriverInfo(driver) {
    const content = document.getElementById("viewDriverContent");
    const formatDate = dateStr => {
        if (!dateStr) return "Не указано";
        try {
            return new Date(dateStr).toLocaleDateString("ru-RU");
        } catch {
            return dateStr;
        }
    };
    const formatPassport = () => {
        if (!driver.passport_series && !driver.passport_number) return "Не указано";
        return [ driver.passport_series, driver.passport_number ].filter(Boolean).join(" ");
    };
    const formatLicense = () => {
        if (!driver.license_series && !driver.license_number) return "Не указано";
        return [ driver.license_series, driver.license_number ].filter(Boolean).join("-");
    };
    content.innerHTML = `\n    <div style="display: grid; gap: 24px;">\n      \x3c!-- Основная информация --\x3e\n      <div class="form-section">\n        <div class="form-section-title">Основная информация</div>\n        <div class="form-grid">\n          <div class="form-field full-width">\n            <label>ФИО</label>\n            <div style="padding: 10px; background: #f9fafb; border-radius: 6px; border: 1px solid #e5e7eb;">\n              ${driver.full_name || "Не указано"}\n            </div>\n          </div>\n          <div class="form-field">\n            <label>Дата рождения</label>\n            <div style="padding: 10px; background: #f9fafb; border-radius: 6px; border: 1px solid #e5e7eb;">\n              ${formatDate(driver.birth_date)}\n            </div>\n          </div>\n          <div class="form-field">\n            <label>Табельный номер</label>\n            <div style="padding: 10px; background: #f9fafb; border-radius: 6px; border: 1px solid #e5e7eb;">\n              ${driver.personnel_number || "Не указано"}\n            </div>\n          </div>\n          <div class="form-field full-width">\n            <label>Контактный телефон</label>\n            <div style="padding: 10px; background: #f9fafb; border-radius: 6px; border: 1px solid #e5e7eb;">\n              ${driver.phone || "Не указано"}\n            </div>\n          </div>\n        </div>\n      </div>\n      \n      \x3c!-- Паспорт --\x3e\n      <div class="form-section">\n        <div class="form-section-title">Паспорт</div>\n        <div class="form-grid">\n          <div class="form-field">\n            <label>Тип паспорта</label>\n            <div style="padding: 10px; background: #f9fafb; border-radius: 6px; border: 1px solid #e5e7eb;">\n              ${driver.passport_type || "Не указано"}\n            </div>\n          </div>\n          <div class="form-field">\n            <label>Серия и номер</label>\n            <div style="padding: 10px; background: #f9fafb; border-radius: 6px; border: 1px solid #e5e7eb;">\n              ${formatPassport()}\n            </div>\n          </div>\n          <div class="form-field">\n            <label>Дата выдачи</label>\n            <div style="padding: 10px; background: #f9fafb; border-radius: 6px; border: 1px solid #e5e7eb;">\n              ${formatDate(driver.passport_issue_date)}\n            </div>\n          </div>\n          <div class="form-field full-width">\n            <label>Кем выдан</label>\n            <div style="padding: 10px; background: #f9fafb; border-radius: 6px; border: 1px solid #e5e7eb;">\n              ${driver.passport_issued_by || "Не указано"}\n            </div>\n          </div>\n          <div class="form-field full-width">\n            <label>Адрес регистрации</label>\n            <div style="padding: 10px; background: #f9fafb; border-radius: 6px; border: 1px solid #e5e7eb;">\n              ${driver.registration_address || "Не указано"}\n            </div>\n          </div>\n        </div>\n      </div>\n      \n      \x3c!-- ИНН --\x3e\n      <div class="form-section">\n        <div class="form-section-title">ИНН водителя</div>\n        <div class="form-grid">\n          <div class="form-field">\n            <label>ИНН водителя</label>\n            <div style="padding: 10px; background: #f9fafb; border-radius: 6px; border: 1px solid #e5e7eb;">\n              ${driver.inn || "Не указано"}\n            </div>\n          </div>\n        </div>\n      </div>\n      \n      \x3c!-- Водительское удостоверение --\x3e\n      <div class="form-section">\n        <div class="form-section-title">Водительское удостоверение</div>\n        <div class="form-grid">\n          <div class="form-field">\n            <label>Тип</label>\n            <div style="padding: 10px; background: #f9fafb; border-radius: 6px; border: 1px solid #e5e7eb;">\n              ${driver.license_type || "Не указано"}\n            </div>\n          </div>\n          <div class="form-field">\n            <label>Серия</label>\n            <div style="padding: 10px; background: #f9fafb; border-radius: 6px; border: 1px solid #e5e7eb;">\n              ${driver.license_series || "Не указано"}\n            </div>\n          </div>\n          <div class="form-field">\n            <label>Номер</label>\n            <div style="padding: 10px; background: #f9fafb; border-radius: 6px; border: 1px solid #e5e7eb;">\n              ${driver.license_number || "Не указано"}\n            </div>\n          </div>\n          <div class="form-field">\n            <label>Серия и номер (полностью)</label>\n            <div style="padding: 10px; background: #f9fafb; border-radius: 6px; border: 1px solid #e5e7eb;">\n              ${formatLicense()}\n            </div>\n          </div>\n          <div class="form-field">\n            <label>Дата выдачи</label>\n            <div style="padding: 10px; background: #f9fafb; border-radius: 6px; border: 1px solid #e5e7eb;">\n              ${formatDate(driver.license_issue_date)}\n            </div>\n          </div>\n        </div>\n      </div>\n    </div>\n  `;
}

function closeViewDriverModal() {
    document.getElementById("viewDriverModal").style.display = "none";
    if (typeof unlockBodyScroll === "function") {
        unlockBodyScroll();
    }
    currentViewDriverId = null;
}

function editFromView() {
    if (currentViewDriverId) {
        closeViewDriverModal();
        editDriver(currentViewDriverId);
    }
}

function initDrivers() {
    loadUserData();
    loadDrivers();
    initSearch();
}

window.openAddDriverModal = openAddDriverModal;

window.closeAddDriverModal = closeAddDriverModal;

window.submitDriver = submitDriver;

window.deleteDriver = deleteDriver;

window.editDriver = editDriver;

window.viewDriver = viewDriver;

window.closeViewDriverModal = closeViewDriverModal;

window.editFromView = editFromView;

document.addEventListener("DOMContentLoaded", () => {
    initDrivers();
});

if (document.readyState !== "loading") {
    initDrivers();
}