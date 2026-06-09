(function(global) {
    "use strict";
    function escapeAttr(text) {
        if (text == null || text === "") return "";
        return String(text).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }
    function escapeHtml(text) {
        if (text == null || text === "") return "";
        const map = {
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;"
        };
        return String(text).replace(/[&<>"']/g, function(m) {
            return map[m];
        });
    }
    function formatValue(value) {
        return value ? escapeHtml(value) : "—";
    }
    function renderEgovCompanyGridHTML(company) {
        if (!company) return "";
        var statusru = company.statusru || "";
        var liquidated = statusru && String(statusru).toLowerCase().indexOf("ликвидирован") !== -1;
        return '<div class="payment-field"><label>БИН</label><div class="value">' + formatValue(company.bin) + '</div></div><div class="payment-field"><label>Статус</label><div class="value' + (liquidated ? " empty" : "") + '">' + formatValue(company.statusru) + '</div></div><div class="payment-field" style="grid-column: 1 / -1;"><label>Наименование (рус.)</label><div class="value">' + formatValue(company.nameru) + '</div></div><div class="payment-field" style="grid-column: 1 / -1;"><label>Наименование (каз.)</label><div class="value">' + formatValue(company.namekz) + '</div></div><div class="payment-field" style="grid-column: 1 / -1;"><label>Юридический адрес (рус.)</label><div class="value">' + formatValue(company.addressru) + '</div></div><div class="payment-field" style="grid-column: 1 / -1;"><label>Юридический адрес (каз.)</label><div class="value">' + formatValue(company.addresskz) + '</div></div><div class="payment-field"><label>ФИО руководителя</label><div class="value">' + formatValue(company.director) + '</div></div><div class="payment-field"><label>Дата регистрации</label><div class="value">' + formatValue(company.datereg) + '</div></div><div class="payment-field" style="grid-column: 1 / -1;"><label>Вид деятельности (рус.)</label><div class="value">' + formatValue(company.okedru) + '</div></div><div class="payment-field" style="grid-column: 1 / -1;"><label>Вид деятельности (каз.)</label><div class="value">' + formatValue(company.okedkz) + "</div></div>";
    }
    function isValidEgovBin(bin) {
        if (bin == null || bin === "") return false;
        var s = String(bin).trim();
        return s.length === 12 && /^\d{12}$/.test(s);
    }
    global.renderEgovCompanyGridHTML = renderEgovCompanyGridHTML;
    global.isValidEgovBin = isValidEgovBin;
    global.escapeAttr = escapeAttr;
})(typeof window !== "undefined" ? window : this);