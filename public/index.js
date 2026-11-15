(function () {
  var I18N = window.DNLOG_I18N;
  var t = I18N.t;
  var baseUrl = window.location.protocol + '//' + window.location.host;

  document.documentElement.lang = I18N.lang === 'zh' ? 'zh-CN' : 'en';
  document.querySelectorAll('[data-i18n]').forEach(function (el) { el.textContent = t(el.textContent.trim()); });
  var langButton = document.getElementById('lang-switch');
  langButton.textContent = I18N.lang === 'zh' ? 'English' : '中文';
  langButton.addEventListener('click', function () { I18N.setLang(I18N.lang === 'zh' ? 'en' : 'zh'); });
  var icon = document.getElementById('copy-icon');

  function copy(text) {
    function done() { alert(t('API链接已复制！')); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () { fallback(text); done(); });
    } else {
      fallback(text);
      done();
    }
  }

  function fallback(text) {
    var area = document.createElement('textarea');
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    document.body.removeChild(area);
  }

  document.querySelectorAll('.api-item').forEach(function (item) {
    var path = item.getAttribute('data-path');
    item.querySelector('.api-url').textContent = baseUrl + path;
    var button = item.querySelector('.copy-btn');
    button.appendChild(icon.content.cloneNode(true));
    button.appendChild(document.createTextNode(t('复制')));
    button.addEventListener('click', function () { copy(baseUrl + path); });
  });

  fetch('/api/v2/info')
    .then(function (response) { return response.json(); })
    .then(function (info) {
      var version = document.getElementById('version');
      version.textContent = 'v' + info.version;
      version.hidden = false;
      document.getElementById('retention-text').textContent =
        t(info.retention_days > 0 ? '日志留存 ' + info.retention_days + ' 天' : '日志长期留存');
      document.getElementById('retention').hidden = false;
    })
    .catch(function () {});
})();
