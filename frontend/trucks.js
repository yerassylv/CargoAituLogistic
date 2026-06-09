const TRUCKS_API_URL = typeof API_URL !== "undefined" ? API_URL : "https://cargoplatform.onrender.com";

var VEHICLE_ENUMS_FALLBACK = {
    vehicle_composition: [ {
        code: "rigid_truck",
        label_ru: "Одиночный грузовик"
    }, {
        code: "tractor_semitrailer",
        label_ru: "Тягач + полуприцеп"
    }, {
        code: "truck_trailer",
        label_ru: "Грузовик + прицеп"
    }, {
        code: "van",
        label_ru: "Малотоннажный фургон"
    }, {
        code: "pickup",
        label_ru: "Пикап"
    }, {
        code: "special_vehicle",
        label_ru: "Спецтехника"
    } ],
    cargo_body_type: [ {
        code: "curtain",
        label_ru: "Тент (штора)"
    }, {
        code: "box_van",
        label_ru: "Фургон (жёсткий кузов)"
    }, {
        code: "reefer",
        label_ru: "Рефрижератор"
    }, {
        code: "isothermal",
        label_ru: "Изотермический"
    }, {
        code: "flatbed",
        label_ru: "Борт / платформа"
    }, {
        code: "container_chassis",
        label_ru: "Контейнеровоз"
    }, {
        code: "tanker",
        label_ru: "Цистерна"
    }, {
        code: "dump",
        label_ru: "Самосвал"
    }, {
        code: "lowbed",
        label_ru: "Трал / низкорамник"
    } ]
};

async function loadVehicleMeta() {
    if (window._vehicleMetaLoaded && window._vehicleMeta) {
        return window._vehicleMeta;
    }
    try {
        const r = await fetch(`${TRUCKS_API_URL}/api/meta/vehicle-enums`);
        if (!r.ok) {
            throw new Error("meta vehicle-enums " + r.status);
        }
        window._vehicleMeta = await r.json();
        window._vehicleMetaLoaded = true;
        return window._vehicleMeta;
    } catch (e) {
        console.warn("Не удалось загрузить справочники ТС:", e);
        return null;
    }
}

function fillVehicleEnumSelects() {
    const m = window._vehicleMeta || VEHICLE_ENUMS_FALLBACK;
    const compSel = document.getElementById("vehicleComposition");
    const bodySel = document.getElementById("cargoBodyType");
    if (!compSel || !bodySel) {
        return;
    }
    const compVal = compSel.value;
    const bodyVal = bodySel.value;
    compSel.innerHTML = '<option value="">Выберите состав</option>';
    (m.vehicle_composition || []).forEach(function(x) {
        const o = document.createElement("option");
        o.value = x.code;
        o.textContent = x.label_ru;
        compSel.appendChild(o);
    });
    bodySel.innerHTML = '<option value="">Выберите тип кузова</option>';
    (m.cargo_body_type || []).forEach(function(x) {
        const o = document.createElement("option");
        o.value = x.code;
        o.textContent = x.label_ru;
        bodySel.appendChild(o);
    });
    if (compVal) {
        compSel.value = compVal;
    }
    if (bodyVal) {
        bodySel.value = bodyVal;
    }
}

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

let brandSelectsInitialized = false;

function fillBrandSelectOptions() {
    const otherVal = typeof window.BRAND_SELECT_OTHER !== "undefined" ? window.BRAND_SELECT_OTHER : "__other__";
    const tractorSel = document.getElementById("tractorBrandSelect");
    const trailerSel = document.getElementById("trailerBrandSelect");
    if (!tractorSel || !trailerSel) return;
    const fill = function(sel, list) {
        sel.innerHTML = "";
        const opt0 = document.createElement("option");
        opt0.value = "";
        opt0.textContent = "Выберите марку";
        sel.appendChild(opt0);
        (list || []).forEach(function(b) {
            const o = document.createElement("option");
            o.value = b;
            o.textContent = b;
            sel.appendChild(o);
        });
        const oOther = document.createElement("option");
        oOther.value = otherVal;
        oOther.textContent = "Другое…";
        sel.appendChild(oOther);
    };
    if (!brandSelectsInitialized) {
        fill(tractorSel, window.TRACTOR_BRANDS || []);
        fill(trailerSel, window.TRAILER_BRANDS || []);
        tractorSel.addEventListener("change", onTractorBrandChange);
        trailerSel.addEventListener("change", onTrailerBrandChange);
        brandSelectsInitialized = true;
    }
}

function onTractorBrandChange() {
    const otherVal = typeof window.BRAND_SELECT_OTHER !== "undefined" ? window.BRAND_SELECT_OTHER : "__other__";
    const sel = document.getElementById("tractorBrandSelect");
    const inp = document.getElementById("tractorBrandOther");
    if (!inp || !sel) return;
    inp.style.display = sel.value === otherVal ? "block" : "none";
    if (sel.value !== otherVal) inp.value = "";
}

function onTrailerBrandChange() {
    const otherVal = typeof window.BRAND_SELECT_OTHER !== "undefined" ? window.BRAND_SELECT_OTHER : "__other__";
    const sel = document.getElementById("trailerBrandSelect");
    const inp = document.getElementById("trailerBrandOther");
    if (!inp || !sel) return;
    inp.style.display = sel.value === otherVal ? "block" : "none";
    if (sel.value !== otherVal) inp.value = "";
}

function getTractorBrandValue() {
    const otherVal = typeof window.BRAND_SELECT_OTHER !== "undefined" ? window.BRAND_SELECT_OTHER : "__other__";
    const sel = document.getElementById("tractorBrandSelect");
    const inp = document.getElementById("tractorBrandOther");
    if (!sel) return null;
    if (sel.value === otherVal) return inp && inp.value.trim() ? inp.value.trim() : null;
    return sel.value || null;
}

function getTrailerBrandValue() {
    const otherVal = typeof window.BRAND_SELECT_OTHER !== "undefined" ? window.BRAND_SELECT_OTHER : "__other__";
    const sel = document.getElementById("trailerBrandSelect");
    const inp = document.getElementById("trailerBrandOther");
    if (!sel) return null;
    if (sel.value === otherVal) return inp && inp.value.trim() ? inp.value.trim() : null;
    return sel.value || null;
}

function setTractorBrandField(saved) {
    const otherVal = typeof window.BRAND_SELECT_OTHER !== "undefined" ? window.BRAND_SELECT_OTHER : "__other__";
    const sel = document.getElementById("tractorBrandSelect");
    const inp = document.getElementById("tractorBrandOther");
    if (!sel) return;
    const list = window.TRACTOR_BRANDS || [];
    if (!saved) {
        sel.value = "";
        if (inp) {
            inp.value = "";
            inp.style.display = "none";
        }
        return;
    }
    if (list.includes(saved)) {
        sel.value = saved;
        if (inp) {
            inp.value = "";
            inp.style.display = "none";
        }
    } else {
        sel.value = otherVal;
        if (inp) {
            inp.value = saved;
            inp.style.display = "block";
        }
    }
}

function setTrailerBrandField(saved) {
    const otherVal = typeof window.BRAND_SELECT_OTHER !== "undefined" ? window.BRAND_SELECT_OTHER : "__other__";
    const sel = document.getElementById("trailerBrandSelect");
    const inp = document.getElementById("trailerBrandOther");
    if (!sel) return;
    const list = window.TRAILER_BRANDS || [];
    if (!saved) {
        sel.value = "";
        if (inp) {
            inp.value = "";
            inp.style.display = "none";
        }
        return;
    }
    if (list.includes(saved)) {
        sel.value = saved;
        if (inp) {
            inp.value = "";
            inp.style.display = "none";
        }
    } else {
        sel.value = otherVal;
        if (inp) {
            inp.value = saved;
            inp.style.display = "block";
        }
    }
}

function resetBrandOtherInputs() {
    const tIn = document.getElementById("tractorBrandOther");
    const trIn = document.getElementById("trailerBrandOther");
    if (tIn) {
        tIn.value = "";
        tIn.style.display = "none";
    }
    if (trIn) {
        trIn.value = "";
        trIn.style.display = "none";
    }
}

async function loadVehicles() {
    try {
        const user = loadUserData();
        if (!user) {
            console.warn("Пользователь не авторизован");
            const tbody = document.getElementById("vehiclesTableBody");
            if (tbody) {
                tbody.innerHTML = `\n          <div class="empty">\n            <div class="empty-icon"></div>\n            <div class="empty-title">Требуется авторизация</div>\n            <div class="empty-text">Войдите в систему, чтобы просмотреть машины</div>\n          </div>\n        `;
            }
            return;
        }
        const url = `${TRUCKS_API_URL}/api/vehicles`;
        console.log("Запрос к:", url, "User ID:", user.id);
        let headers;
        try {
            headers = getHeaders();
        } catch (error) {
            console.error("Ошибка получения заголовков:", error);
            throw new Error("Пользователь не авторизован. Пожалуйста, войдите в систему.");
        }
        const response = await fetch(url, {
            headers: headers
        });
        console.log("Статус ответа:", response.status, response.statusText);
        if (!response.ok) {
            const errorText = await response.text();
            console.error("Текст ошибки:", errorText);
            if (response.status === 404) {
                try {
                    const errorJson = JSON.parse(errorText);
                    if (errorJson.detail && errorJson.detail.includes("Пользователь не найден")) {
                        throw new Error("Ваш аккаунт не найден в базе данных. Пожалуйста, войдите в систему заново.");
                    }
                } catch (e) {}
            }
            throw new Error(`Ошибка загрузки машин: ${response.status} ${response.statusText}`);
        }
        const vehicles = await response.json();
        console.log("Загружено машин:", vehicles.length);
        displayVehicles(vehicles);
    } catch (error) {
        console.error("Ошибка загрузки машин:", error);
        const tbody = document.getElementById("vehiclesTableBody");
        if (tbody) {
            tbody.innerHTML = `\n        <div class="empty">\n          <div class="empty-icon"></div>\n          <div class="empty-title">Ошибка загрузки машин</div>\n          <div class="empty-text">${error.message}</div>\n          <div class="empty-text" style="margin-top: 10px; font-size: 12px; color: #999;">\n            Проверьте, что сервер запущен на ${TRUCKS_API_URL}<br>\n            Убедитесь, что вы авторизованы в системе\n          </div>\n        </div>\n      `;
        }
    }
}

function displayVehicles(vehicles) {
    const tbody = document.getElementById("vehiclesTableBody");
    if (!tbody) return;
    if (vehicles.length === 0) {
        tbody.innerHTML = `\n      <div class="empty">\n        <div class="empty-icon"></div>\n        <div class="empty-title">Нет машин</div>\n        <div class="empty-text">Добавьте первую машину</div>\n      </div>\n    `;
        return;
    }
    tbody.innerHTML = vehicles.map(vehicle => {
        const bodyLabel = vehicle.body_type_label_ru || vehicle.body_type || "";
        const description = vehicle.description || (bodyLabel && vehicle.tonnage && vehicle.volume ? `${bodyLabel}, ${vehicle.tonnage} т/${vehicle.volume} м³` : "-");
        const vehicleName = vehicle.tractor_license_plate || vehicle.trailer_license_plate || vehicle.composition_label_ru || vehicle.vehicle_type;
        return `\n      <div class="table-row">\n        <div onclick="openVehicleDetail(${vehicle.id})" style="cursor: pointer;">${vehicle.composition_label_ru || vehicle.vehicle_type || "-"}</div>\n        <div onclick="openVehicleDetail(${vehicle.id})" style="cursor: pointer;">${vehicle.tractor_license_plate || "-"}</div>\n        <div onclick="openVehicleDetail(${vehicle.id})" style="cursor: pointer;">${vehicle.trailer_license_plate || "-"}</div>\n        <div onclick="openVehicleDetail(${vehicle.id})" style="cursor: pointer;">${vehicle.phone || "-"}</div>\n        <div onclick="openVehicleDetail(${vehicle.id})" style="cursor: pointer;">${description}</div>\n        <div onclick="event.stopPropagation();" style="display: flex; gap: 8px; justify-content: flex-end;">\n          <button class="btn-edit" onclick="editVehicle(${vehicle.id})">Редактировать</button>\n          <button class="btn-delete" onclick="deleteVehicle(${vehicle.id}, '${vehicleName}')">Удалить</button>\n        </div>\n      </div>\n    `;
    }).join("");
}

function updateVehicleForm() {
    const compEl = document.getElementById("vehicleComposition");
    const comp = compEl ? compEl.value : "";
    const trailerSection = document.getElementById("trailerSection");
    const tractorSection = document.getElementById("tractorSection");
    const phoneSection = document.getElementById("phoneSection");
    if (!trailerSection || !tractorSection || !phoneSection) {
        return;
    }
    if (comp === "van") {
        trailerSection.style.display = "none";
        tractorSection.style.display = "none";
        phoneSection.style.display = "block";
    } else if (comp === "tractor_semitrailer" || comp === "truck_trailer" || comp === "special_vehicle") {
        trailerSection.style.display = "block";
        tractorSection.style.display = "block";
        phoneSection.style.display = "block";
    } else if (comp === "rigid_truck" || comp === "pickup") {
        trailerSection.style.display = "none";
        tractorSection.style.display = "block";
        phoneSection.style.display = "block";
    } else {
        trailerSection.style.display = "block";
        tractorSection.style.display = "block";
        phoneSection.style.display = "block";
    }
}

function updateCarrierInfo() {
    const actualCarrier = document.getElementById("actualCarrier").value;
    const infoText = document.getElementById("carrierInfoText");
    if (actualCarrier === "Моя организация") {
        infoText.textContent = "Выберите «Моя организация», если транспортное средство принадлежит вам, находится в аренде или лизинге (с экипажем или без).";
    } else {
        infoText.textContent = "Выберите «Сторонняя организация», если транспортное средство участвует в договорах перевозки или экспедирования.";
    }
}

function togglePhoneSection(event) {
    event.preventDefault();
    const container = document.getElementById("phoneInputContainer");
    const link = event.target;
    if (container.style.display === "none") {
        container.style.display = "block";
        link.textContent = "− Убрать номер телефона";
    } else {
        container.style.display = "none";
        link.textContent = "+ Дополнить номером телефона в машине";
        document.getElementById("vehiclePhone").value = "";
    }
}

async function openAddVehicleModal() {
    const user = loadUserData();
    if (!user) {
        showWarning("Необходимо авторизоваться", "Вход");
        return;
    }
    document.getElementById("addVehicleModal").style.display = "flex";
    if (typeof lockBodyScroll === "function") {
        lockBodyScroll();
    }
    document.getElementById("addVehicleForm").reset();
    delete document.getElementById("addVehicleForm").dataset.vehicleId;
    document.querySelector("#addVehicleModal .modal-header h2").textContent = "Добавить машину";
    resetBrandOtherInputs();
    setTractorBrandField(null);
    setTrailerBrandField(null);
    await loadVehicleMeta();
    fillVehicleEnumSelects();
    fillBrandSelectOptions();
    updateVehicleForm();
    updateCarrierInfo();
}

function closeAddVehicleModal() {
    document.getElementById("addVehicleModal").style.display = "none";
    if (typeof unlockBodyScroll === "function") {
        unlockBodyScroll();
    }
}

async function submitVehicle(event) {
    event.preventDefault();
    try {
        const user = loadUserData();
        if (!user) {
            showWarning("Необходимо авторизоваться", "Вход");
            return;
        }
        const compSel = document.getElementById("vehicleComposition");
        const bodySel = document.getElementById("cargoBodyType");
        const phoneContainer = document.getElementById("phoneInputContainer");
        const phone = phoneContainer.style.display !== "none" ? document.getElementById("vehiclePhone").value : null;
        const vehicleComposition = compSel ? compSel.value : "";
        const cargoBodyType = bodySel ? bodySel.value : "";
        if (!vehicleComposition || !cargoBodyType) {
            showWarning("Выберите состав ТС и тип кузова");
            return;
        }
        const bodyLabel = bodySel && bodySel.options[bodySel.selectedIndex] ? bodySel.options[bodySel.selectedIndex].textContent : "";
        const vehicleData = {
            vehicle_composition: vehicleComposition,
            cargo_body_type: cargoBodyType,
            actual_carrier: document.getElementById("actualCarrier").value,
            carrier_registration_country: document.getElementById("carrierRegistrationCountry").value,
            tractor_registration: document.getElementById("tractorRegistration").value || null,
            tractor_license_plate: document.getElementById("tractorLicensePlate").value || null,
            tractor_brand: getTractorBrandValue(),
            trailer_registration: document.getElementById("trailerRegistration").value || null,
            trailer_license_plate: document.getElementById("trailerLicensePlate").value || null,
            trailer_brand: getTrailerBrandValue(),
            tonnage: document.getElementById("tonnage").value ? parseFloat(document.getElementById("tonnage").value) : null,
            volume: document.getElementById("volume").value ? parseFloat(document.getElementById("volume").value) : null,
            phone: phone || null,
            description: null
        };
        if (bodyLabel && vehicleData.tonnage && vehicleData.volume) {
            vehicleData.description = `${bodyLabel}, ${vehicleData.tonnage} т/${vehicleData.volume} м³`;
        }
        const form = document.getElementById("addVehicleForm");
        const vehicleId = form.dataset.vehicleId;
        const isEdit = !!vehicleId;
        const url = isEdit ? `${TRUCKS_API_URL}/api/vehicles/${vehicleId}` : `${TRUCKS_API_URL}/api/vehicles`;
        const method = isEdit ? "PUT" : "POST";
        const response = await fetch(url, {
            method: method,
            headers: getHeaders(),
            body: JSON.stringify(vehicleData)
        });
        if (!response.ok) {
            const error = await response.json().catch(function() {
                return {};
            });
            console.error("Ошибка:", error);
            const d = error.detail;
            const msg = Array.isArray(d) ? d.map(function(x) {
                return x.msg || JSON.stringify(x);
            }).join("; ") : typeof d === "string" ? d : d ? JSON.stringify(d) : "";
            throw new Error(msg || `Ошибка ${isEdit ? "обновления" : "создания"} машины`);
        }
        const result = await response.json();
        closeAddVehicleModal();
        loadVehicles();
        showSuccess(`Машина успешно ${isEdit ? "обновлена" : "добавлена"}`);
    } catch (error) {
        console.error("Ошибка создания машины:", error);
        showError(error.message);
    }
}

function initSearch() {
    const searchInput = document.getElementById("vehicleSearch");
    if (searchInput) {
        searchInput.addEventListener("input", e => {
            console.log("Поиск:", e.target.value);
        });
    }
}

function initVehicles() {
    loadUserData();
    loadVehicleMeta().catch(function() {});
    loadVehicles();
    initSearch();
}

async function deleteVehicle(vehicleId, vehicleName) {
    if (!confirm(`Вы уверены, что хотите удалить машину "${vehicleName}"?`)) {
        return;
    }
    try {
        const response = await fetch(`${TRUCKS_API_URL}/api/vehicles/${vehicleId}`, {
            method: "DELETE",
            headers: getHeaders()
        });
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || "Ошибка удаления машины");
        }
        loadVehicles();
        showSuccess("Машина успешно удалена");
    } catch (error) {
        console.error("Ошибка удаления машины:", error);
        showError(error.message);
    }
}

async function editVehicle(vehicleId) {
    try {
        await loadVehicleMeta();
        fillVehicleEnumSelects();
        const response = await fetch(`${TRUCKS_API_URL}/api/vehicles/${vehicleId}`, {
            headers: getHeaders()
        });
        if (!response.ok) {
            throw new Error("Ошибка загрузки данных машины");
        }
        const vehicle = await response.json();
        const compSel = document.getElementById("vehicleComposition");
        const bodySel = document.getElementById("cargoBodyType");
        if (compSel) {
            compSel.value = vehicle.vehicle_composition || "";
        }
        if (bodySel) {
            bodySel.value = vehicle.cargo_body_type || "";
        }
        document.getElementById("actualCarrier").value = vehicle.actual_carrier || "Моя организация";
        document.getElementById("carrierRegistrationCountry").value = vehicle.carrier_registration_country || "Казахстан";
        document.getElementById("tractorRegistration").value = vehicle.tractor_registration || "";
        document.getElementById("tractorLicensePlate").value = vehicle.tractor_license_plate || "";
        document.getElementById("trailerRegistration").value = vehicle.trailer_registration || "";
        document.getElementById("trailerLicensePlate").value = vehicle.trailer_license_plate || "";
        document.getElementById("tonnage").value = vehicle.tonnage || "";
        document.getElementById("volume").value = vehicle.volume || "";
        if (vehicle.phone) {
            document.getElementById("phoneInputContainer").style.display = "block";
            document.getElementById("vehiclePhone").value = vehicle.phone;
            document.querySelector("#phoneSection a").textContent = "− Убрать номер телефона";
        } else {
            document.getElementById("phoneInputContainer").style.display = "none";
            document.getElementById("vehiclePhone").value = "";
            document.querySelector("#phoneSection a").textContent = "+ Дополнить номером телефона в машине";
        }
        document.getElementById("addVehicleForm").dataset.vehicleId = vehicleId;
        document.querySelector("#addVehicleModal .modal-header h2").textContent = "Редактирование машины";
        fillBrandSelectOptions();
        setTractorBrandField(vehicle.tractor_brand || null);
        setTrailerBrandField(vehicle.trailer_brand || null);
        document.getElementById("addVehicleModal").style.display = "flex";
        if (typeof lockBodyScroll === "function") {
            lockBodyScroll();
        }
        updateVehicleForm();
        updateCarrierInfo();
    } catch (error) {
        console.error("Ошибка загрузки машины:", error);
        showError(error.message);
    }
}

function openVehicleDetail(vehicleId) {
    editVehicle(vehicleId);
}

window.openAddVehicleModal = openAddVehicleModal;

window.closeAddVehicleModal = closeAddVehicleModal;

window.submitVehicle = submitVehicle;

window.updateVehicleForm = updateVehicleForm;

window.updateCarrierInfo = updateCarrierInfo;

window.togglePhoneSection = togglePhoneSection;

window.openVehicleDetail = openVehicleDetail;

window.deleteVehicle = deleteVehicle;

window.editVehicle = editVehicle;

document.addEventListener("DOMContentLoaded", () => {
    initVehicles();
});

if (document.readyState !== "loading") {
    initVehicles();
}