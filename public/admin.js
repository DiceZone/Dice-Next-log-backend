(function () {
  'use strict';

  var I18N = window.DNLOG_I18N;
  var t = I18N.t;
  var app = document.getElementById('app');
  var toastEl = document.getElementById('toast');
  var toastTimer = null;

  // ── 小工具 ──────────────────────────────────────────────

  // 所有来自日志的文字都经 textContent 写入，不拼 HTML。
  // text / placeholder / aria-label 是界面文字，会按当前语言翻译；
  // 来自日志或服务器的内容（名称、账号、路径、消息）用 data 写入，原样显示。
  function h(tag, props) {
    var el = document.createElement(tag);
    Object.keys(props || {}).forEach(function (name) {
      var value = props[name];
      if (value === undefined || value === null || value === false) return;
      if (name === 'class') el.className = value;
      else if (name === 'text') el.textContent = t(value);
      else if (name === 'data') el.textContent = value;
      else if (name === 'placeholder' || name === 'aria-label') el.setAttribute(name, t(value));
      else if (name.indexOf('on') === 0) el.addEventListener(name.slice(2), value);
      else if (name === 'checked' || name === 'disabled' || name === 'value' || name === 'selected') el[name] = value;
      else el.setAttribute(name, value);
    });
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }

  function append(el, child) {
    if (child === undefined || child === null || child === false) return;
    if (Array.isArray(child)) child.forEach(function (c) { append(el, c); });
    else el.appendChild(typeof child === 'string' ? document.createTextNode(t(child)) : child);
  }

  function toast(message, isError) {
    toastEl.textContent = t(message);
    toastEl.className = 'toast' + (isError ? ' error' : '');
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, 3000);
  }

  function api(method, path, body) {
    var options = { method: method, credentials: 'same-origin', headers: {} };
    if (method !== 'GET') options.headers['X-Requested-With'] = 'dnlog-admin';
    if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    return fetch('/admin/api/' + path, options).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (response.ok) return data;
        if (response.status === 401 && path !== 'login') boot();
        var error = new Error(data.message || '请求失败（HTTP ' + response.status + '）。');
        error.status = response.status;
        throw error;
      });
    });
  }

  function showError(error) {
    toast(error.message, true);
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(2) + ' MB';
    return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  function pad(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function formatTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function storageLabel(name) {
    return name === 'local' ? '本地缓存' : name;
  }

  var SOURCE_TEXT = { upload: '一次性上传', backup: '站点转发', w4123: 'Dice! 插件', live: '实时串流', import: '旧站导入' };

  function field(label, input, hint) {
    return h('div', { class: 'field' }, h('label', { text: label }), input, hint ? h('div', { class: 'hint', text: hint }) : null);
  }

  function dialog(title, body, buttons, wide) {
    var el = h('dialog', { class: wide ? 'wide' : '' },
      h('div', { class: 'dialog-title', text: title }),
      h('div', { class: 'dialog-body' }, body),
      h('div', { class: 'dialog-footer' }, buttons));
    // 关闭后立刻移除，不等 close 事件（页面在后台时该事件会延后）。
    el.dismiss = function () { if (el.open) el.close(); el.remove(); };
    el.addEventListener('close', function () { el.remove(); });
    document.body.appendChild(el);
    el.showModal();
    return el;
  }

  function confirmDialog(title, message, actionText, onConfirm) {
    var el = dialog(title, h('p', { text: message }), [
      h('button', { class: 'btn', type: 'button', text: '取消', onclick: function () { el.dismiss(); } }),
      h('button', {
        class: 'btn btn-danger', type: 'button', text: actionText,
        onclick: function () { el.dismiss(); onConfirm(); },
      }),
    ]);
  }

  // ── 首次设置 / 登录 ─────────────────────────────────────

  function authCard(title, fields, submitText, onSubmit) {
    var errorEl = h('div', { class: 'error-text', hidden: 'hidden' });
    var button = h('button', { class: 'btn btn-primary', type: 'submit', text: submitText });
    var form = h('form', {
      onsubmit: function (event) {
        event.preventDefault();
        errorEl.hidden = true;
        button.disabled = true;
        onSubmit().then(boot).catch(function (error) {
          errorEl.textContent = t(error.message);
          errorEl.hidden = false;
          button.disabled = false;
        });
      },
    }, fields, errorEl, h('div', { class: 'form-actions' }, button));
    app.replaceChildren(h('div', { class: 'card auth-card' },
      h('div', { class: 'card-title', text: title }),
      h('div', { class: 'card-body' }, form)));
  }

  function renderSetup() {
    var code = h('input', { type: 'text', autocomplete: 'off', required: 'required' });
    var username = h('input', { type: 'text', autocomplete: 'username', required: 'required' });
    var password = h('input', { type: 'password', autocomplete: 'new-password', required: 'required' });
    var repeat = h('input', { type: 'password', autocomplete: 'new-password', required: 'required' });
    authCard('设置管理员账号', [
      field('设置码', code, '设置码显示在服务器的启动输出中，也可在服务器执行 node cli.mjs setup-code 查看。'),
      field('用户名', username, '3–32 位的字母、数字、下划线、点或短横线。'),
      field('密码', password, '8–128 个字符。'),
      field('确认密码', repeat),
    ], '完成设置', function () {
      if (password.value !== repeat.value) return Promise.reject(new Error('两次输入的密码不一致。'));
      return api('POST', 'setup', { setup_code: code.value, username: username.value, password: password.value });
    });
  }

  function renderLogin() {
    var username = h('input', { type: 'text', autocomplete: 'username', required: 'required' });
    var password = h('input', { type: 'password', autocomplete: 'current-password', required: 'required' });
    authCard('登录后台管理', [field('用户名', username), field('密码', password)], '登录', function () {
      return api('POST', 'login', { username: username.value, password: password.value });
    });
  }

  // ── 主界面 ──────────────────────────────────────────────

  var currentTab = 'logs';
  var TABS = [['logs', '日志'], ['keys', '骰娘密钥'], ['bans', 'IP 封锁'], ['settings', '设置'], ['account', '账号']];

  function renderMain() {
    var content = h('div', {});
    var tabs = h('div', { class: 'tabs' }, TABS.map(function (tab) {
      return h('button', {
        class: 'tab' + (tab[0] === currentTab ? ' active' : ''), type: 'button', text: tab[1],
        onclick: function () { currentTab = tab[0]; renderMain(); },
      });
    }));
    app.replaceChildren(tabs, content);
    if (currentTab === 'logs') renderLogs(content);
    else if (currentTab === 'keys') renderKeys(content);
    else if (currentTab === 'bans') renderBans(content);
    else if (currentTab === 'settings') renderSettings(content);
    else renderAccount(content);
  }

  // ── 日志 ────────────────────────────────────────────────

  var query = { q: '', bot: '', group: '', participant: '', status: '', source: '', sort: 'created_desc', page: 1, page_size: 50 };

  function renderLogs(root) {
    var selected = new Set();
    var statsEl = h('div', { class: 'stats' });
    var listEl = h('div', {});
    var batchEl = h('div', { class: 'batch-bar', hidden: 'hidden' });

    function select(name, options) {
      return h('select', {
        onchange: function (event) { query[name] = event.target.value; query.page = 1; load(); },
      }, options.map(function (option) {
        return h('option', { value: option[0], text: option[1], selected: query[name] === option[0] });
      }));
    }

    var search = h('input', { type: 'search', placeholder: '搜索名称、Key、uniform_id 或备注', value: query.q });
    var botInput = h('input', { type: 'search', class: 'filter-id', placeholder: '骰娘号', value: query.bot });
    var groupInput = h('input', { type: 'search', class: 'filter-id', placeholder: '群号', value: query.group });
    var participantInput = h('input', { type: 'search', class: 'filter-id', placeholder: '参与者账号或昵称', value: query.participant });
    var searchForm = h('form', {
      class: 'toolbar',
      onsubmit: function (event) {
        event.preventDefault();
        query.q = search.value.trim();
        query.bot = botInput.value.trim();
        query.group = groupInput.value.trim();
        query.participant = participantInput.value.trim();
        query.page = 1;
        load();
      },
    },
      search, botInput, groupInput, participantInput,
      select('status', [['', '全部状态'], ['done', '已完结'], ['live', '进行中'], ['pinned', '永久保留']]),
      select('source', [['', '全部来源'], ['upload', '一次性上传'], ['live', '实时串流'], ['w4123', 'Dice! 插件'], ['backup', '站点转发'], ['import', '旧站导入']]),
      select('sort', [['created_desc', '最新在前'], ['created_asc', '最早在前'], ['size_desc', '体积最大在前']]),
      h('button', { class: 'btn', type: 'submit', text: '搜索' }),
      h('button', { class: 'btn', type: 'button', text: '刷新', onclick: function () { load(); } }));

    root.replaceChildren(statsEl, h('div', { class: 'card' }, searchForm, batchEl, listEl));

    function loadStats() {
      api('GET', 'stats').then(function (stats) {
        statsEl.replaceChildren(
          stat('日志总数', String(stats.total)),
          stat('占用空间', formatSize(stats.bytes)),
          stat('进行中的实时日志', String(stats.live)),
          stat('近 24 小时新增', String(stats.last_day)));
      }).catch(showError);
    }

    function stat(label, value) {
      return h('div', { class: 'stat' }, h('div', { class: 'stat-label', text: label }), h('div', { class: 'stat-value', data: value }));
    }

    function updateBatch() {
      batchEl.hidden = selected.size === 0;
      batchEl.replaceChildren(
        h('span', { text: '已选择 ' + selected.size + ' 份日志' }),
        h('button', {
          class: 'btn btn-danger', type: 'button', text: '删除所选',
          onclick: function () {
            var keys = Array.from(selected);
            confirmDialog('删除日志', '将删除所选的 ' + keys.length + ' 份日志，删除后无法恢复。', '删除', function () {
              api('POST', 'logs/batch-delete', { keys: keys }).then(function (result) {
                toast('已删除 ' + result.deleted + ' 份日志。');
                load();
              }).catch(showError);
            });
          },
        }),
        h('button', { class: 'btn-link', type: 'button', text: '取消选择', onclick: function () { load(); } }));
    }

    function load() {
      selected.clear();
      updateBatch();
      loadStats();
      var params = new URLSearchParams();
      Object.keys(query).forEach(function (name) { if (query[name] !== '') params.set(name, query[name]); });
      api('GET', 'logs?' + params.toString()).then(renderTable).catch(showError);
    }

    function renderTable(data) {
      if (data.items.length === 0) {
        listEl.replaceChildren(h('div', { class: 'empty', text: '没有符合条件的日志。' }));
        return;
      }
      var boxes = [];
      var all = h('input', {
        type: 'checkbox', 'aria-label': '全选本页',
        onchange: function () {
          boxes.forEach(function (entry) {
            entry.box.checked = all.checked;
            if (all.checked) selected.add(entry.key); else selected.delete(entry.key);
          });
          updateBatch();
        },
      });

      var rows = data.items.map(function (log) {
        var box = h('input', {
          type: 'checkbox', 'aria-label': '选择 ' + log.key,
          onchange: function () {
            if (box.checked) selected.add(log.key); else selected.delete(log.key);
            updateBatch();
          },
        });
        boxes.push({ box: box, key: log.key });
        var status = log.status === 'live'
          ? h('span', { class: 'badge badge-live', text: '进行中' })
          : h('span', { class: 'badge', text: '已完结' });
        var expires = log.pinned
          ? h('span', { class: 'badge badge-pinned', text: '永久保留' })
          : log.status === 'live' ? '完结后计算' : log.expires_at ? formatTime(log.expires_at) : '不自动删除';
        return h('tr', {},
          h('td', {}, box),
          log.name ? h('td', { class: 'name', title: log.name, data: log.name }) : h('td', { class: 'name', text: '（未命名）' }),
          h('td', { class: 'mono', data: log.bot_id }),
          h('td', { class: 'mono', data: log.group_id }),
          h('td', { text: SOURCE_TEXT[log.source] || log.source }),
          h('td', { data: log.client }),
          h('td', { data: formatSize(log.size) }),
          h('td', {}, status),
          h('td', { data: formatTime(log.created_at) }),
          h('td', {}, expires),
          h('td', { class: 'actions' },
            h('a', { class: 'btn-link', href: log.url, target: '_blank', rel: 'noopener noreferrer', text: '查看' }),
            h('button', { class: 'btn-link', type: 'button', text: '详情', onclick: function () { openDetail(log); } }),
            h('button', { class: 'btn-link', type: 'button', text: '编辑', onclick: function () { openEdit(log); } }),
            log.status === 'live'
              ? h('button', { class: 'btn-link', type: 'button', text: '完结', onclick: function () { finalize(log); } })
              : null,
            h('button', { class: 'btn-link danger', type: 'button', text: '删除', onclick: function () { remove(log); } })));
      });

      var pages = Math.max(Math.ceil(data.total / data.page_size), 1);
      listEl.replaceChildren(
        h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {},
            h('th', {}, all),
            ['名称', '骰娘号', '群号', '来源', '格式', '大小', '状态', '创建时间', '到期时间', ''].map(function (text) { return h('th', { text: text }); }))),
          h('tbody', {}, rows))),
        h('div', { class: 'pager' },
          h('span', { text: '共 ' + data.total + ' 份，第 ' + data.page + ' / ' + pages + ' 页' }),
          h('div', { class: 'pager-buttons' },
            h('select', {
              'aria-label': '每页条数',
              onchange: function (event) { query.page_size = Number(event.target.value); query.page = 1; load(); },
            }, [20, 50, 100, 200].map(function (size) {
              return h('option', { value: String(size), text: '每页 ' + size + ' 份', selected: query.page_size === size });
            })),
            h('button', { class: 'btn', type: 'button', text: '上一页', disabled: data.page <= 1, onclick: function () { query.page -= 1; load(); } }),
            h('button', { class: 'btn', type: 'button', text: '下一页', disabled: data.page >= pages, onclick: function () { query.page += 1; load(); } }))));
    }

    function remove(log) {
      confirmDialog('删除日志', '将删除日志「' + (log.name || log.key) + '」，删除后无法恢复。', '删除', function () {
        api('DELETE', 'logs/' + log.key).then(function () { toast('日志已删除。'); load(); }).catch(showError);
      });
    }

    function finalize(log) {
      confirmDialog('完结实时日志', '将完结日志「' + (log.name || log.key) + '」，完结后骰娘无法继续向它追加消息。', '完结', function () {
        api('POST', 'logs/' + log.key + '/finalize').then(function (result) {
          toast(result.deleted ? '该日志没有任何消息，已删除。' : '日志已完结。');
          load();
        }).catch(showError);
      });
    }

    function openEdit(log) {
      var name = h('input', { type: 'text', value: log.name, maxlength: '200' });
      var note = h('textarea', { maxlength: '500' });
      note.value = log.note;
      var pinned = h('input', { type: 'checkbox', checked: log.pinned, id: 'edit-pinned' });
      var el = dialog('编辑日志', [
        field('名称', name),
        field('备注', note),
        h('div', { class: 'field-inline' }, pinned, h('label', { for: 'edit-pinned', text: '永久保留，不随保留期限删除' })),
      ], [
        h('button', { class: 'btn', type: 'button', text: '取消', onclick: function () { el.dismiss(); } }),
        h('button', {
          class: 'btn btn-primary', type: 'button', text: '保存',
          onclick: function () {
            api('PATCH', 'logs/' + log.key, { name: name.value, note: note.value, pinned: pinned.checked })
              .then(function () { el.dismiss(); toast('已保存。'); load(); })
              .catch(showError);
          },
        }),
      ]);
    }

    function openDetail(log) {
      var meta = h('dl', { class: 'meta-list' });
      [
        ['名称', log.name], ['Key', log.key], ['分享链接', log.url],
        ['骰娘号', log.bot_id], ['群号', log.group_id],
        ['来源', t(SOURCE_TEXT[log.source] || log.source)], ['格式', log.client],
        ['uniform_id', log.uniform_id], ['上传 IP', log.uploader_ip],
        ['大小', formatSize(log.size)], ['存储位置', log.status === 'live' ? '' : t(storageLabel(log.storage))],
        ['创建时间', formatTime(log.created_at)],
        ['最后更新', formatTime(log.updated_at)], ['备注', log.note],
      ].forEach(function (pair) {
        if (!pair[1]) return;
        meta.appendChild(h('dt', { text: pair[0] }));
        meta.appendChild(h('dd', { data: pair[1] }));
      });
      var previewEl = h('div', { class: 'hint', text: '正在读取内容……' });
      var el = dialog('日志详情', [meta, previewEl], [
        h('button', { class: 'btn', type: 'button', text: '关闭', onclick: function () { el.dismiss(); } }),
      ], true);
      api('GET', 'logs/' + log.key + '/preview').then(function (data) {
        if (data.participants.length) {
          meta.appendChild(h('dt', { text: '参与者' }));
          meta.appendChild(h('dd', {
            data: data.participants.map(function (p) { return p.nickname + '（' + p.user_id + '）'; }).join('、'),
          }));
        }
        if (!data.supported) {
          previewEl.textContent = t('该格式无法在后台预览内容，请使用「查看」在染色器中打开。');
          return;
        }
        var head = data.total > data.items.length
          ? '共 ' + data.total + ' 条消息，以下为前 ' + data.items.length + ' 条：'
          : '共 ' + data.total + ' 条消息：';
        previewEl.className = '';
        previewEl.replaceChildren(h('div', { class: 'hint', text: head }));
        append(previewEl, data.items.map(function (item) {
          var time = item.time ? formatTime(new Date(item.time * 1000).toISOString()) : '';
          return h('div', { class: 'preview-item' + (item.is_dice ? ' dice' : '') },
            h('div', { class: 'preview-head', data: item.nickname + '（' + item.user_id + '） ' + time }),
            h('div', { class: 'preview-message', data: item.message }));
        }));
      }).catch(function (error) { previewEl.textContent = t(error.message); });
    }

    load();
  }

  // ── 骰娘密钥 ────────────────────────────────────────────

  function renderKeys(root) {
    var botInput = h('input', { type: 'text', maxlength: '64' });
    var nameInput = h('input', { type: 'text', maxlength: '100' });
    var countInput = h('input', { type: 'number', min: '1', max: '50', step: '1', value: '1' });
    var listEl = h('div', {});

    function showIssued(items) {
      var area = h('textarea', { class: 'issued-keys', readonly: 'readonly', spellcheck: 'false' });
      area.value = items.map(function (item) { return item.key; }).join('\n');
      area.rows = Math.min(Math.max(items.length, 2), 12);
      var el = dialog('骰娘密钥已签发', [
        h('p', { class: 'error-text', text: '密钥只显示这一次，关闭后无法再次查看，请立即保存。' }),
        area,
      ], [
        h('button', {
          class: 'btn', type: 'button', text: '复制',
          onclick: function () {
            area.select();
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(area.value).then(function () { toast('已复制。'); }).catch(function () { document.execCommand('copy'); });
            } else {
              document.execCommand('copy');
              toast('已复制。');
            }
          },
        }),
        h('button', { class: 'btn btn-primary', type: 'button', text: '关闭', onclick: function () { el.dismiss(); } }),
      ], true);
    }

    function issue(event) {
      event.preventDefault();
      api('POST', 'keys', { bot_id: botInput.value.trim(), name: nameInput.value.trim(), count: Number(countInput.value) })
        .then(function (data) {
          nameInput.value = '';
          countInput.value = '1';
          showIssued(data.items);
          load();
        }).catch(showError);
    }

    function label(key) {
      return key.name || key.key_prefix + '…';
    }

    function load() {
      api('GET', 'keys').then(function (data) {
        if (data.items.length === 0) {
          listEl.replaceChildren(h('div', { class: 'empty', text: '尚未签发骰娘密钥。' }));
          return;
        }
        var rows = data.items.map(function (key) {
          return h('tr', {},
            key.name ? h('td', { class: 'name', title: key.name, data: key.name }) : h('td', { class: 'name', text: '（无备注）' }),
            h('td', { class: 'mono', data: key.bot_id }),
            h('td', { class: 'mono', data: key.key_prefix + '…' }),
            h('td', {}, key.enabled ? h('span', { class: 'badge badge-live', text: '启用' }) : h('span', { class: 'badge', text: '已停用' })),
            h('td', { data: formatTime(key.created_at) }),
            key.last_used_at ? h('td', { data: formatTime(key.last_used_at) }) : h('td', { text: '从未使用' }),
            h('td', { class: 'actions' },
              h('button', {
                class: 'btn-link', type: 'button', text: key.enabled ? '停用' : '启用',
                onclick: function () {
                  api('PATCH', 'keys/' + key.id, { enabled: !key.enabled }).then(load).catch(showError);
                },
              }),
              h('button', {
                class: 'btn-link danger', type: 'button', text: '删除',
                onclick: function () {
                  confirmDialog('删除骰娘密钥', '将删除骰娘密钥「' + label(key) + '」，使用它的骰娘将无法再上传实时日志或查询日志。', '删除', function () {
                    api('DELETE', 'keys/' + key.id).then(function () { toast('骰娘密钥已删除。'); load(); }).catch(showError);
                  });
                },
              })));
        });
        listEl.replaceChildren(h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, ['备注', '骰娘号', '密钥开头', '状态', '创建时间', '最后使用', ''].map(function (text) { return h('th', { text: text }); }))),
          h('tbody', {}, rows))));
      }).catch(showError);
    }

    root.replaceChildren(
      h('div', { class: 'card' },
        h('div', { class: 'card-title', text: '签发骰娘密钥' }),
        h('div', { class: 'card-body' },
          h('form', { onsubmit: issue },
            h('div', { class: 'settings-grid' },
              field('骰娘号', botInput, '用这把密钥上传的日志会记到该骰娘号名下；可留空。'),
              field('备注', nameInput, '用于辨认这把密钥，例如骰娘的名字。'),
              field('数量', countInput, '一次可签发 1–50 把；多把时备注后会加上序号。')),
            h('p', { class: 'hint', text: '持有骰娘密钥的骰娘可以上传实时日志，并查询自己名下的日志。' }),
            h('div', { class: 'form-actions' }, h('button', { class: 'btn btn-primary', type: 'submit', text: '签发' }))))),
      h('div', { class: 'card' }, h('div', { class: 'card-title', text: '已签发的骰娘密钥' }), listEl));
    load();
  }

  // ── IP 封锁 ─────────────────────────────────────────────

  var AUTOBAN_FIELDS = [
    ['autoban_threshold', '可疑请求次数', '达到此次数即封锁。可疑请求指被拒绝、地址或日志不存在、触发限频的请求。'],
    ['autoban_window_minutes', '统计时间（分钟）', '在这段时间内累计上面的次数。'],
    ['autoban_hours', '封锁时长（小时）', '填 0 表示永久封锁。'],
  ];

  function renderBans(root) {
    var targetInput = h('input', { type: 'text', maxlength: '64', placeholder: '1.2.3.4' });
    var reasonInput = h('input', { type: 'text', maxlength: '200' });
    var hoursInput = h('input', { type: 'number', min: '0', max: '87600', step: '1', value: '0' });
    var listEl = h('div', {});
    var autoCard = h('div', { class: 'card' });

    function add(event) {
      event.preventDefault();
      api('POST', 'bans', { target: targetInput.value.trim(), reason: reasonInput.value.trim(), hours: Number(hoursInput.value) })
        .then(function () {
          targetInput.value = '';
          reasonInput.value = '';
          toast('已加入封锁名单。');
          load();
        }).catch(showError);
    }

    function load() {
      api('GET', 'bans').then(function (data) {
        if (data.items.length === 0) {
          listEl.replaceChildren(h('div', { class: 'empty', text: '封锁名单是空的。' }));
          return;
        }
        var rows = data.items.map(function (ban) {
          return h('tr', {},
            h('td', { class: 'mono', data: ban.target }),
            h('td', { text: ban.source === 'auto' ? '自动' : '手动' }),
            ban.source === 'auto' ? h('td', { class: 'name', text: ban.reason }) : h('td', { class: 'name', title: ban.reason, data: ban.reason }),
            h('td', { data: formatTime(ban.created_at) }),
            ban.expires_at ? h('td', { data: formatTime(ban.expires_at) }) : h('td', { text: '永久' }),
            h('td', { class: 'actions' }, h('button', {
              class: 'btn-link', type: 'button', text: '解除',
              onclick: function () {
                api('DELETE', 'bans/' + ban.id).then(function () { toast('已解除封锁。'); load(); }).catch(showError);
              },
            })));
        });
        listEl.replaceChildren(h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, ['IP 或网段', '来源', '理由', '封锁时间', '到期时间', ''].map(function (text) { return h('th', { text: text }); }))),
          h('tbody', {}, rows))));
      }).catch(showError);
    }

    function loadAuto() {
      api('GET', 'settings').then(function (data) {
        var inputs = {};
        var enabled = h('input', { type: 'checkbox', id: 'autoban-enabled', checked: data.values.autoban_enabled === 1 });
        var grid = h('div', { class: 'settings-grid' }, AUTOBAN_FIELDS.map(function (def) {
          var limit = data.limits[def[0]];
          var input = h('input', { type: 'number', min: String(limit.min), max: String(limit.max), step: '1', value: String(data.values[def[0]]) });
          inputs[def[0]] = input;
          return field(def[1], input, def[2]);
        }));
        autoCard.replaceChildren(
          h('div', { class: 'card-title', text: '自动封锁' }),
          h('div', { class: 'card-body' },
            h('div', { class: 'field-inline' }, enabled, h('label', { for: 'autoban-enabled', text: '启用自动封锁' })),
            grid,
            h('div', { class: 'form-actions' }, h('button', {
              class: 'btn btn-primary', type: 'button', text: '保存',
              onclick: function () {
                var body = { autoban_enabled: enabled.checked ? 1 : 0 };
                Object.keys(inputs).forEach(function (name) { body[name] = Number(inputs[name].value); });
                api('PUT', 'settings', body).then(function () { toast('设置已保存。'); }).catch(showError);
              },
            }))));
      }).catch(showError);
    }

    root.replaceChildren(
      h('div', { class: 'card' },
        h('div', { class: 'card-title', text: '手动封锁' }),
        h('div', { class: 'card-body' },
          h('form', { onsubmit: add },
            h('div', { class: 'settings-grid' },
              field('IP 或网段', targetInput, '单个 IP，或 IPv4 网段（如 1.2.3.0/24）。'),
              field('封锁时长（小时）', hoursInput, '填 0 表示永久封锁。'),
              field('理由', reasonInput)),
            h('p', { class: 'hint', text: '被封锁的 IP 访问本站的任何地址都会被拒绝。内网与本机地址不会被封锁。' }),
            h('div', { class: 'form-actions' }, h('button', { class: 'btn btn-primary', type: 'submit', text: '封锁' }))))),
      autoCard,
      h('div', { class: 'card' }, h('div', { class: 'card-title', text: '封锁名单' }), listEl));
    load();
    loadAuto();
  }

  // ── 设置 ────────────────────────────────────────────────

  var SETTING_FIELDS = [
    ['retention_days', '日志保留期限（天）', '超过期限的日志会被自动删除；填 0 表示不自动删除。标记为永久保留的日志不受影响。'],
    ['max_upload_mb', '单份日志大小上限（MB）', '一次性上传的文件超过此大小时会被拒绝。'],
    ['upload_rate_per_hour', '同一 IP 每小时上传次数上限', '只计一次性上传，实时日志的追加不受影响。填 0 表示不限制。'],
    ['live_idle_hours', '实时日志闲置自动完结（小时）', '实时日志在此时间内没有新消息时会被自动完结。'],
    ['live_max_mb', '单份实时日志大小上限（MB）', '实时日志累计的消息超过此大小后不再接收新消息。'],
    ['live_max_per_owner', '同一骰娘密钥可同时进行的实时日志数', ''],
  ];

  var SITE_FIELDS = [
    ['frontend_url', '染色器地址', '用于生成日志的分享链接，并放行该来源的跨域请求。', 'https://'],
    ['cors_origins', '额外放行的来源', '除染色器外允许跨域访问的网址，多个以逗号分隔。', ''],
    ['legacy_upstream_url', '旧站地址', '本站查不到的日志会转去该地址读取；留空则不转。', ''],
    ['trust_proxy_header', '访客 IP 请求头', '反向代理或 CDN 传递访客真实 IP 的请求头；留空则使用连接地址。', ''],
    ['bdc_verify_url', '骰娘密钥校验地址', 'BDC 账号站校验骰娘密钥的接口地址。', 'https://'],
  ];

  var LIVE_AUTH_TEXT = { local: '本站签发的骰娘密钥', static: '配置文件中列出的骰娘密钥', bdc: 'BDC 账号站' };

  function liveAuthText(modes) {
    if (!modes.length) return t('未配置，实时串流与骰娘查询不可用');
    return modes.map(function (mode) { return t(LIVE_AUTH_TEXT[mode]); }).join(I18N.lang === 'zh' ? '、' : ', ');
  }

  var STORAGE_STATE = { online: '在线', uninitialized: '未初始化', offline: '离线', missing: '配置中已移除' };

  function renderStorage(card) {
    function act(path, body, message) {
      api('POST', path, body).then(function () {
        if (message) toast(message);
        setTimeout(load, 600);
      }).catch(showError);
    }

    function actions(loc) {
      var list = [];
      if (loc.state === 'uninitialized' || loc.state === 'offline') {
        list.push(h('button', {
          class: 'btn-link', type: 'button', text: loc.state === 'offline' ? '重新初始化' : '初始化',
          onclick: function () {
            confirmDialog('初始化存储位置', '将在「' + loc.path + '」写入标记文件，之后该位置可用于存放日志。请先确认该目录已正确挂载。', '初始化', function () {
              act('storage/init', { name: loc.name }, '存储位置已初始化。');
            });
          },
        }));
      }
      if (loc.state === 'online' && !loc.target) {
        list.push(h('button', {
          class: 'btn-link', type: 'button', text: '设为写入位置',
          onclick: function () {
            confirmDialog('更改写入位置', '之后上传的日志将存放到「' + storageLabel(loc.name) + '」，已存放在其他位置的日志保持原处。', '更改', function () {
              act('storage/target', { name: loc.name }, '写入位置已更改。');
            });
          },
        }));
      }
      if (!loc.builtin && !loc.target && loc.state === 'online') {
        if (loc.draining) {
          list.push(h('button', {
            class: 'btn-link', type: 'button', text: '停止迁出',
            onclick: function () { act('storage/drain', { name: loc.name, enabled: false }, '已停止迁出。'); },
          }));
        } else if (loc.count > 0) {
          list.push(h('button', {
            class: 'btn-link', type: 'button', text: '迁出日志',
            onclick: function () {
              confirmDialog('迁出日志', '将把「' + loc.name + '」中的 ' + loc.count + ' 份日志搬往当前写入位置。', '迁出', function () {
                act('storage/drain', { name: loc.name, enabled: true }, '已开始迁出。');
              });
            },
          }));
        }
      }
      return list;
    }

    function load() {
      api('GET', 'storage').then(function (data) {
        var rows = data.locations.map(function (loc) {
          return h('tr', {},
            h('td', {}, storageLabel(loc.name),
              loc.target ? h('span', { class: 'badge badge-live storage-badge', text: '写入位置' }) : null,
              loc.draining ? h('span', { class: 'badge badge-pinned storage-badge', text: '迁出中' }) : null),
            h('td', { class: 'mono', data: loc.path }),
            h('td', { text: STORAGE_STATE[loc.state] || loc.state }),
            h('td', { data: String(loc.count) }),
            h('td', { data: formatSize(loc.bytes) }),
            h('td', { class: 'actions' }, actions(loc)));
        });
        var mover = data.mover;
        var status = '等待搬运的日志：' + mover.pending + ' 份；等待删除的文件：' + mover.pending_deletes + ' 份。';
        card.replaceChildren(
          h('div', { class: 'card-title', text: '存储位置' }),
          h('div', { class: 'table-wrap' }, h('table', {},
            h('thead', {}, h('tr', {}, ['位置', '路径', '状态', '日志数', '占用空间', ''].map(function (text) { return h('th', { text: text }); }))),
            h('tbody', {}, rows))),
          h('div', { class: 'card-body' },
            h('p', { class: 'hint', text: status }),
            mover.last_error ? h('p', { class: 'error-text', data: formatTime(mover.last_error_at) + '　' + t(mover.last_error) }) : null,
            h('p', { class: 'hint', text: '日志上传后先写入本地缓存，随后搬往写入位置。存储位置在服务器的 .env 文件 STORAGES 中增减，修改后需重启服务。' }),
            h('div', { class: 'form-actions' },
              h('button', { class: 'btn', type: 'button', text: '刷新', onclick: load }),
              h('button', { class: 'btn', type: 'button', text: '立即搬运', onclick: function () { act('storage/run'); } }))));
      }).catch(showError);
    }

    load();
  }

  var importTimer = null;

  function renderImport(card) {
    var baseInput = h('input', { type: 'text', placeholder: 'https://' });
    var tokenInput = h('input', { type: 'password', autocomplete: 'new-password' });
    var indexInput = h('textarea', { class: 'import-index', spellcheck: 'false' });
    var statusEl = h('div', {});
    var startButton = h('button', { class: 'btn btn-primary', type: 'button', text: '开始迁移' });
    var stopButton = h('button', { class: 'btn', type: 'button', text: '停止' });
    var filled = false;

    function show(data) {
      if (!filled) {
        baseInput.value = data.base_url || '';
        tokenInput.placeholder = data.token_set ? '已保存，留空则沿用' : '';
        indexInput.placeholder = data.saved_index ? '已保存 ' + data.saved_index + ' 条索引，留空则沿用' : '{"version":1,"logs":[…]}';
        filled = true;
      }
      startButton.disabled = data.running;
      stopButton.disabled = !data.running || data.stopping;
      var parts = [];
      if (data.running) {
        parts.push(h('p', { text: data.stopping ? '正在停止……' : '正在迁移……' }));
      } else if (data.finished_at) {
        parts.push(h('p', { class: 'hint', text: '上次迁移结束于 ' + formatTime(data.finished_at) + '。' }));
      }
      if (data.error) parts.push(h('p', { class: 'error-text', text: data.error }));
      if (data.total > 0) {
        parts.push(h('progress', { class: 'import-progress', max: String(data.total), value: String(data.done) }));
        parts.push(h('p', {
          text: '已处理 ' + data.done + ' / ' + data.total + ' 份：新迁入 ' + data.created + '，本站已有 ' + data.exists
            + '，旧站已不存在 ' + data.missing + '，冲突 ' + data.conflict + '，失败 ' + data.failed + '。',
        }));
      }
      if (data.problems.length) {
        parts.push(h('ul', { class: 'import-problems' }, data.problems.map(function (text) { return h('li', { text: text }); })));
      }
      statusEl.replaceChildren();
      append(statusEl, parts);
      clearTimeout(importTimer);
      if (data.running && document.body.contains(card)) importTimer = setTimeout(poll, 1500);
    }

    function poll() {
      api('GET', 'import').then(show).catch(showError);
    }

    startButton.addEventListener('click', function () {
      var body = { base_url: baseInput.value.trim() };
      if (tokenInput.value) body.token = tokenInput.value;
      if (indexInput.value.trim()) body.index = indexInput.value;
      api('POST', 'import/start', body).then(function (data) {
        tokenInput.value = '';
        indexInput.value = '';
        filled = false;
        show(data);
      }).catch(showError);
    });
    stopButton.addEventListener('click', function () {
      api('POST', 'import/stop').then(show).catch(showError);
    });

    card.replaceChildren(
      h('div', { class: 'card-title', text: '旧站迁移' }),
      h('div', { class: 'card-body' },
        field('旧站地址', baseInput, '按旧站的索引把全部日志迁到本站，保留原来的 Key、密码与创建时间。'),
        field('索引内容', indexInput, '在 EdgeOne Pages 控制台的 KV 存储中打开键 0Aindex，把它的值完整贴到这里。'),
        field('导出令牌', tokenInput, '旧站部署了索引导出接口时填写，可代替上面的索引内容。'),
        statusEl,
        h('p', { class: 'hint', text: '本站已有的日志会跳过，可随时停止并再次执行。' }),
        h('div', { class: 'form-actions' }, stopButton, startButton)));
    poll();
  }

  function renderSettings(root) {
    api('GET', 'settings').then(function (data) {
      var inputs = {};
      var grid = h('div', { class: 'settings-grid' }, SETTING_FIELDS.map(function (def) {
        var limit = data.limits[def[0]];
        var input = h('input', { type: 'number', min: String(limit.min), max: String(limit.max), step: '1', value: String(data.values[def[0]]) });
        inputs[def[0]] = input;
        return field(def[1], input, def[2]);
      }));
      var liveEnabled = h('input', { type: 'checkbox', id: 'live-enabled', checked: data.values.live_enabled === 1 });

      function save() {
        var body = { live_enabled: liveEnabled.checked ? 1 : 0 };
        Object.keys(inputs).forEach(function (name) { body[name] = Number(inputs[name].value); });
        api('PUT', 'settings', body).then(function () { toast('设置已保存。'); }).catch(showError);
      }

      var siteInputs = {};
      var siteFields = SITE_FIELDS.map(function (def) {
        var input = h('input', { type: 'text', value: data.site[def[0]] || '', placeholder: def[3] || '' });
        siteInputs[def[0]] = input;
        return field(def[1], input, def[2]);
      });
      var tokenInput = h('input', {
        type: 'password', autocomplete: 'new-password',
        placeholder: data.site.bdc_verify_token_set ? '已设置，留空则不修改' : '尚未设置',
      });
      var liveAuthEl = h('dd', { data: liveAuthText(data.live_auth_modes) });
      var originHeaderInput = h('input', { type: 'text', value: data.site.origin_auth_header || '', placeholder: 'x-origin-auth' });
      var originTokenInput = h('input', {
        type: 'text', autocomplete: 'off', spellcheck: 'false',
        placeholder: data.site.origin_auth_token_set ? '已设置，留空则不修改' : '尚未设置',
      });
      var generateButton = h('button', {
        class: 'btn', type: 'button', text: '随机生成',
        onclick: function () {
          var bytes = new Uint8Array(24);
          window.crypto.getRandomValues(bytes);
          originTokenInput.value = Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
        },
      });

      function saveSite() {
        var body = {};
        Object.keys(siteInputs).forEach(function (name) { body[name] = siteInputs[name].value.trim(); });
        if (tokenInput.value) body.bdc_verify_token = tokenInput.value;
        body.origin_auth_header = originHeaderInput.value.trim();
        if (originTokenInput.value.trim()) body.origin_auth_token = originTokenInput.value.trim();
        api('PUT', 'settings', { site: body }).then(function () {
          toast('站点配置已保存，立即生效。');
          renderSettings(root);
        }).catch(showError);
      }

      function cleanup() {
        api('POST', 'cleanup').then(function (result) {
          toast('已删除 ' + result.deleted + ' 份过期日志。');
        }).catch(showError);
      }

      var storageCard = h('div', { class: 'card' });
      renderStorage(storageCard);
      var importCard = h('div', { class: 'card' });
      renderImport(importCard);

      root.replaceChildren(
        h('div', { class: 'card' },
          h('div', { class: 'card-title', text: '日志与上传' }),
          h('div', { class: 'card-body' },
            grid,
            h('div', { class: 'field-inline' }, liveEnabled, h('label', { for: 'live-enabled', text: '开放实时串流上传' })),
            h('div', { class: 'form-actions' },
              h('button', { class: 'btn', type: 'button', text: '立即清理过期日志', onclick: cleanup }),
              h('button', { class: 'btn btn-primary', type: 'button', text: '保存设置', onclick: save })))),
        storageCard,
        h('div', { class: 'card' },
          h('div', { class: 'card-title', text: '站点配置' }),
          h('div', { class: 'card-body' },
            siteFields,
            field('骰娘密钥校验凭据', tokenInput, '与 BDC 账号站约定的凭据。'),
            field('回源校验请求头', originHeaderInput, '在 CDN 设置回源时附带这个请求头与下面的密钥后，本站只接受带着它的请求，绕过 CDN 直连源站的请求会被拒绝。留空则不校验。'),
            field('回源校验密钥', h('div', { class: 'input-row' }, originTokenInput, generateButton), '16–256 个英文字符。请先在 CDN 配置好并生效，再在这里保存；保存时会核对当前请求是否已带上它。'),
            h('dl', { class: 'env-list' }, h('dt', { text: '可用的骰娘密钥校验方式' }), liveAuthEl),
            h('div', { class: 'form-actions' },
              h('button', { class: 'btn btn-primary', type: 'button', text: '保存站点配置', onclick: saveSite })))),
        importCard);
    }).catch(showError);
  }

  // ── 账号 ────────────────────────────────────────────────

  function renderAccount(root) {
    var oldPassword = h('input', { type: 'password', autocomplete: 'current-password', required: 'required' });
    var newPassword = h('input', { type: 'password', autocomplete: 'new-password', required: 'required' });
    var repeat = h('input', { type: 'password', autocomplete: 'new-password', required: 'required' });
    var form = h('form', {
      onsubmit: function (event) {
        event.preventDefault();
        if (newPassword.value !== repeat.value) return toast('两次输入的新密码不一致。', true);
        api('POST', 'password', { old_password: oldPassword.value, new_password: newPassword.value })
          .then(function () { form.reset(); toast('密码已修改，其他设备上的登录状态已失效。'); })
          .catch(showError);
      },
    },
      field('当前密码', oldPassword),
      field('新密码', newPassword, '8–128 个字符。'),
      field('确认新密码', repeat),
      h('div', { class: 'form-actions' }, h('button', { class: 'btn btn-primary', type: 'submit', text: '修改密码' })));
    root.replaceChildren(h('div', { class: 'card' },
      h('div', { class: 'card-title', text: '修改密码' }),
      h('div', { class: 'card-body' }, form,
        h('p', { class: 'hint', text: '忘记密码时，请在服务器执行 node cli.mjs reset-admin 后重新设置账号。' }))));
  }

  // ── 启动 ────────────────────────────────────────────────

  document.getElementById('logout').addEventListener('click', function () {
    api('POST', 'logout').then(boot).catch(showError);
  });

  // 页面上写死的文字与语言切换按钮。
  document.title = t('后台管理') + ' - Dice!Next Log Service';
  document.documentElement.lang = I18N.lang === 'zh' ? 'zh-CN' : 'en';
  document.querySelectorAll('[data-i18n]').forEach(function (el) { el.textContent = t(el.textContent.trim()); });
  var langButton = document.getElementById('lang-switch');
  langButton.textContent = I18N.lang === 'zh' ? 'English' : '中文';
  langButton.addEventListener('click', function () { I18N.setLang(I18N.lang === 'zh' ? 'en' : 'zh'); });

  function boot() {
    return api('GET', 'state').then(function (state) {
      document.getElementById('navbar-user').hidden = !state.logged_in;
      document.getElementById('navbar-username').textContent = state.username || '';
      if (state.setup_required) renderSetup();
      else if (!state.logged_in) renderLogin();
      else renderMain();
    }).catch(showError);
  }

  boot();
})();
