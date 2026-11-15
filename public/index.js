(function () {
  var baseUrl = window.location.protocol + '//' + window.location.host;
  var icon = document.getElementById('copy-icon');

  function copy(text) {
    function done() { alert('API链接已复制！'); }
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
    button.appendChild(document.createTextNode('复制'));
    button.addEventListener('click', function () { copy(baseUrl + path); });
  });

  fetch('/api/v2/info')
    .then(function (response) { return response.json(); })
    .then(function (info) {
      var version = document.getElementById('version');
      version.textContent = 'v' + info.version;
      version.hidden = false;
      document.getElementById('retention-text').textContent =
        info.retention_days > 0 ? '日志留存 ' + info.retention_days + ' 天' : '日志长期留存';
      document.getElementById('retention').hidden = false;
    })
    .catch(function () {});
})();
