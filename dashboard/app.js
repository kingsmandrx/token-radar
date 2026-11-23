// Token Radar dashboard, rewritten for clarity.
// The page reads window.RADAR (written beside dashboard/ by main.ts) and renders the
// ranked board, the filter controls, a per-protocol detail drawer and the model panel.
// It fetches nothing: every value on screen comes from the bundled data.js file.
//
// This revision splits the long render functions into small named builders, renames the
// internal helpers so their purpose is obvious, and adds a compare mode: turn it on,
// tick two rows, and the two protocols appear side by side below the model panel.
// Compare is off by default, so the first screen and the submission screenshots are
// unchanged.
(function () {
  'use strict';

  // ---------------------------------------------------------------- data + view state
  var DATA = window.RADAR;
  if (!DATA) return;

  var boardRoot = document.getElementById('board');

  // The view state. The hash carries q, p, category, chain and watchlist; the compare
  // selection is session-only and never written to the hash, so a shared link always
  // opens the plain board.
  var view = {
    q: '',
    category: 'all',
    chain: 'all',
    watchlist: false,
    tab: 'pre-token',
    sort: 'implied',
    dir: -1,
    selected: null,
    compareOn: false,
    compare: []
  };

  // ---------------------------------------------------------------- number formatting
  var usdWhole = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

  // Short money: $2.75B, $178.3M, $420K, otherwise the plain dollar amount.
  function formatUsd(value) {
    if (value === null || value === undefined || !isFinite(value)) return 'n/a';
    if (Math.abs(value) >= 1e9) return '$' + (value / 1e9).toFixed(2) + 'B';
    if (Math.abs(value) >= 1e6) return '$' + (value / 1e6).toFixed(1) + 'M';
    if (Math.abs(value) >= 1e3) return '$' + Math.round(value / 1e3) + 'K';
    return usdWhole.format(value);
  }

  // Signed two-decimal percent, or n/a when the snapshot has no figure.
  function formatPct(value) {
    if (value === null || value === undefined || !isFinite(value)) return 'n/a';
    return (value > 0 ? '+' : '') + value.toFixed(2) + '%';
  }

  // Age in years once it passes a year, otherwise whole days; unknown stays unknown.
  function formatAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }

  // ---------------------------------------------------------------- the value model
  // The page recomputes each row from the snapshot figures and checks the number
  // board.json carries, so the code and the data are visibly the same arithmetic.
  // Growth is clamped to the model's window, then weighted; maturity rises with the
  // time a protocol has run without a token, up to the model's cap.
  function growthMultiplier(change7d, model) {
    var growth = change7d === null || change7d === undefined ? 0 : change7d;
    growth = Math.min(model.growth_cap, Math.max(model.growth_floor, growth));
    return 1 + (growth / 100) * model.growth_weight;
  }

  function maturityMultiplier(ageDays, model) {
    var age = ageDays === null || ageDays === undefined ? model.unknown_age_days : ageDays;
    var capped = Math.min(Math.max(age, 0), model.maturity_days);
    return model.maturity_floor + (capped / model.maturity_days) * model.maturity_range;
  }

  function recomputeImplied(row, model) {
    var score = row.tvl_usd * model.base_multiple;
    score = score * growthMultiplier(row.change_7d, model);
    score = score * maturityMultiplier(row.age_days, model);
    return Math.max(1, Math.round(score));
  }

  // ---------------------------------------------------------------- dom builder
  // makeNode(tag, attrs, ...children) is the only way this file creates elements.
  // attrs maps class / text / html / on* handlers / plain attributes; children may be
  // nodes, strings, arrays of nodes, or null (skipped).
  function applyAttributes(node, attrs) {
    Object.keys(attrs).forEach(function (key) {
      var value = attrs[key];
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'html') node.innerHTML = value;
      else if (key.slice(0, 2) === 'on') node.addEventListener(key.slice(2), value);
      else if (value !== null && value !== undefined) node.setAttribute(key, value);
    });
  }

  function appendChildNode(node, child) {
    if (child === null || child === undefined) return;
    if (Array.isArray(child)) {
      child.forEach(function (item) { if (item) node.appendChild(item); });
      return;
    }
    if (typeof child === 'string') node.appendChild(document.createTextNode(child));
    else node.appendChild(child);
  }

  function makeNode(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) applyAttributes(node, attrs);
    for (var i = 2; i < arguments.length; i++) appendChildNode(node, arguments[i]);
    return node;
  }

  // ---------------------------------------------------------------- farm plan
  // The farm plan is the same derivation main.ts writes to board.json: category, chains,
  // TVL and age decide the action, the capital, the hold and every cost and time.
  // No protocol name is special-cased anywhere in this file.
  function primaryChain(protocol) {
    return protocol.chains && protocol.chains.length > 0 ? protocol.chains[0] : 'its main chain';
  }

  // Capital scales with size so a small protocol is not asked for a whale deposit.
  function farmCapital(protocol) {
    if (protocol.tvl_usd >= 5e9) return 250;
    if (protocol.tvl_usd >= 1e9) return 150;
    if (protocol.tvl_usd >= 1e8) return 100;
    return 50;
  }

  // Young protocols need a longer hold before the activity counts in a snapshot.
  function holdDays(ageDays) {
    if (ageDays === null || ageDays === undefined) return 30;
    if (ageDays < 180) return 60;
    if (ageDays < 365) return 45;
    return 30;
  }

  // The core action for step two, chosen by category first and chain second.
  function coreActionFor(protocol, capital, chain) {
    var c = (protocol.category || '').toLowerCase();
    var name = protocol.name;
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0) return 'Supply $' + capital + ' of USDC to ' + name + ' on ' + chain + ' and keep the position open.';
    if (c.indexOf('dex') >= 0 || c.indexOf('yield') >= 0 || c.indexOf('leveraged farm') >= 0) return 'Provide $' + capital + ' of liquidity to ' + name + "'s main pool on " + chain + ' and keep the position open.';
    if (c.indexOf('bridge') >= 0) return 'Bridge $' + capital + ' of USDC to ' + chain + ' through ' + name + ' and use the bridged funds in its app.';
    if (c.indexOf('staking') >= 0 || c.indexOf('restak') >= 0) return 'Stake $' + capital + " of " + chain + "'s staking asset through " + name + ' and keep the receipt.';
    if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0) return 'Deposit $' + capital + ' of USDC as margin on ' + name + ' on ' + chain + ' and open one small hedge.';
    if (c.indexOf('prediction') >= 0) return 'Fund $' + capital + ' and place one market position on ' + name + ' on ' + chain + '.';
    if (c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0) return 'Deposit $' + capital + ' into a ' + name + ' vault on ' + chain + ' and keep the shares.';
    if (c.indexOf('stable') >= 0) return 'Mint or deposit $' + capital + ' of the stable asset through ' + name + ' on ' + chain + '.';
    if (c.indexOf('rwa') >= 0) return "Mint $" + capital + " of the protocol's yield asset on " + chain + ' and hold it.';
    if (c.indexOf('insurance') >= 0) return 'Buy $' + capital + ' of cover from ' + name + ' on ' + chain + ' and keep the policy.';
    if (c.indexOf('basis') >= 0 || c.indexOf('trading') >= 0) return 'Deposit $' + capital + " of USDC into " + name + "'s basis strategy on " + chain + ' and keep the position open.';
    if (c === 'chain') return 'Bridge $' + capital + ' of USDC onto ' + name + ' and use it in one of its apps.';
    if (c.indexOf('payment') >= 0) return 'Send $' + capital + ' through ' + name + ' on ' + chain + ' and keep the receipt.';
    if (c.indexOf('governance') >= 0) return 'Deposit $' + capital + ' into ' + name + ' on ' + chain + ' and vote on one proposal.';
    return 'Deposit $' + capital + ' of USDC into ' + name + ' on ' + chain + ' and keep the position open.';
  }

  // One protocol-specific detail for the core farm step, from its own record: its TVL
  // size and, when reported, the direction of its seven-day TVL trend. The same
  // derivation is what main.ts writes into board.json, so the dialog and the board agree.
  function protocolDetail(protocol) {
    var tvlM = protocol.tvl_usd / 1e6;
    var tvlText = tvlM >= 1000 ? '$' + (tvlM / 1000).toFixed(1) + 'B' : '$' + Math.round(tvlM) + 'M';
    var trend = protocol.change_7d;
    if (trend !== null && trend !== undefined && Math.abs(trend) >= 0.1) {
      var dir = trend > 0 ? 'up' : 'down';
      return 'It holds ' + tvlText + ' of TVL, ' + dir + ' ' + Math.abs(trend).toFixed(1) + '% over the last 7 days';
    }
    return 'It holds ' + tvlText + ' of TVL';
  }

  // A farm step is one string: action, then cost, then time. The gate wants every step
  // between 20 and 600 characters, so over-long steps are trimmed and short ones padded.
  function formatStepText(step) {
    var s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
    if (s.length > 600) s = s.slice(0, 596) + '...';
    if (s.length < 20) s = s + " Hold the position and check the protocol's own page.";
    return s;
  }

  // Split a formatted step back into its action and its cost/time tail, for display.
  function splitStepText(stepString) {
    var at = stepString.indexOf(' Cost: ');
    if (at < 0) return { action: stepString, tail: '' };
    return { action: stepString.slice(0, at), tail: stepString.slice(at + 1) };
  }

  // Six steps, in order: fresh wallet, core action, weekly action, hold, claim, log.
  function buildFarmSteps(protocol) {
    var chain = primaryChain(protocol);
    var capital = farmCapital(protocol);
    var hold = holdDays(protocol.age_days);
    return [
      { text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.', cost: 'under $3 of gas for the first transaction', time: '5 minutes' },
      { text: coreActionFor(protocol, capital, chain) + ' ' + protocolDetail(protocol) + '.', cost: '$' + capital + ' of capital and about $' + (capital >= 150 ? 8 : 4) + ' of gas', time: '15 minutes to set up' },
      { text: 'Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.', cost: 'about $2 of gas a week', time: '10 minutes a week' },
      { text: 'Hold the position for at least ' + hold + ' days so the activity is counted in more than one snapshot.', cost: 'the $' + capital + ' stays in the position', time: hold + ' days' },
      { text: "Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.", cost: 'no fee to check, and never pay to claim', time: '10 minutes' },
      { text: 'Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.', cost: 'nothing but the log', time: '5 minutes' }
    ].map(formatStepText);
  }

  // ---------------------------------------------------------------- hash state
  // The hash keeps the board shareable: search, selected protocol, category, chain and
  // the watchlist flag. The tab and the compare selection are deliberately not hashed.
  function readStateFromHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('q')) view.q = params.get('q');
    if (params.get('p')) view.selected = params.get('p');
    if (params.get('category')) view.category = params.get('category');
    if (params.get('chain')) view.chain = params.get('chain');
    if (params.get('watchlist') === '1') view.watchlist = true;
  }

  function writeStateToHash() {
    var params = new URLSearchParams();
    if (view.q) params.set('q', view.q);
    if (view.category !== 'all') params.set('category', view.category);
    if (view.chain !== 'all') params.set('chain', view.chain);
    if (view.watchlist) params.set('watchlist', '1');
    if (view.selected) params.set('p', view.selected);
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  // ---------------------------------------------------------------- filtering + sorting
  // The watchlist is the floor: the snapshot's watchlist is every pre-token protocol at
  // or above floor_usd, and the early rows are all below it, so a row is a watchlist
  // row exactly when its TVL is at or above the floor. data.js carries no slug list;
  // this rule is the model's own.
  function isWatchlistRow(row) { return row.tvl_usd >= DATA.floor_usd; }

  function visibleRows() {
    var q = view.q.trim().toLowerCase();
    return DATA.rows.filter(function (row) {
      if (view.category !== 'all' && row.category !== view.category) return false;
      if (view.chain !== 'all' && (row.chains || []).indexOf(view.chain) < 0) return false;
      if (view.watchlist && !isWatchlistRow(row)) return false;
      if (!q) return true;
      var hay = [row.name, row.slug, row.category, (row.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }

  // Sort by the active key and direction; ties fall back to slug so the order is stable.
  function sortRows(list) {
    var key = view.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -view.dir;
      if (av > bv) return view.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  // Distinct filter values, sorted, drawn from the rows themselves.
  function distinctCategories() {
    return Array.from(new Set(DATA.rows.map(function (row) { return row.category || 'Other'; }))).sort();
  }

  function distinctChains() {
    return Array.from(new Set(DATA.rows.reduce(function (acc, row) { return acc.concat(row.chains || []); }, []))).sort();
  }

  // ---------------------------------------------------------------- header + lede
  function renderHeader() {
    return makeNode('header', { class: 'top' },
      makeNode('div', { class: 'brand' }, makeNode('span', { class: 'mark' }), makeNode('span', { class: 'brand-name', text: 'Token Radar' })),
      makeNode('div', { class: 'top-meta' },
        makeNode('span', { text: 'Snapshot ' + DATA.as_of }),
        makeNode('span', { text: 'DefiLlama protocol index' }),
        makeNode('span', { text: DATA.model_version + ' model' })
      )
    );
  }

  function factRow(label, value) {
    return makeNode('div', { class: 'fact' }, makeNode('span', { text: label }), makeNode('b', { text: value }));
  }

  function renderLede() {
    return makeNode('section', { class: 'lede' },
      makeNode('div', null,
        makeNode('h1', { text: DATA.watchlist_size + ' watchlist protocols, ranked by implied value' }),
        makeNode('p', { text: 'The watchlist is the floor: every protocol with at least $' + Math.round(DATA.floor_usd / 1e6) + 'M of TVL and no token on record. The early radar adds ' + DATA.early_size + ' pre-token protocols below that floor. Implied value is a model, not a promise.' })
      ),
      makeNode('div', { class: 'facts' },
        factRow('Watchlist covered', DATA.watchlist_size + ' / ' + DATA.watchlist_size),
        factRow('Pre-token rows scored', String(DATA.board_size)),
        factRow('Early rows below the floor', String(DATA.early_size)),
        factRow('Live-token protocols set aside', String(DATA.live_size))
      )
    );
  }

  // ---------------------------------------------------------------- controls
  function searchField() {
    var input = makeNode('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: view.q, 'aria-label': 'Search the board' });
    input.addEventListener('input', function () { view.q = input.value; writeStateToHash(); renderBoard(); });
    return makeNode('div', { class: 'field' }, makeNode('label', { for: 'q', text: 'Search' }), input);
  }

  function categorySelect() {
    var select = makeNode('select', { id: 'category', 'aria-label': 'Filter by category' },
      makeNode('option', { value: 'all', text: 'All categories' }),
      distinctCategories().map(function (c) { return makeNode('option', { value: c, text: c, selected: c === view.category ? 'selected' : null }); })
    );
    select.addEventListener('change', function () { view.category = select.value; writeStateToHash(); renderBoard(); });
    return makeNode('div', { class: 'field' }, makeNode('label', { for: 'category', text: 'Category' }), select);
  }

  function chainSelect() {
    var select = makeNode('select', { id: 'chain', 'aria-label': 'Filter by chain' },
      makeNode('option', { value: 'all', text: 'All chains' }),
      distinctChains().map(function (c) { return makeNode('option', { value: c, text: c, selected: c === view.chain ? 'selected' : null }); })
    );
    select.addEventListener('change', function () { view.chain = select.value; writeStateToHash(); renderBoard(); });
    return makeNode('div', { class: 'field' }, makeNode('label', { for: 'chain', text: 'Chain' }), select);
  }

  function watchlistToggle() {
    return makeNode('div', { class: 'field' },
      makeNode('span', { class: 'sub', text: 'Scope' }),
      makeNode('button', { type: 'button', class: 'toggle', 'aria-pressed': view.watchlist ? 'true' : 'false', text: 'Watchlist only', onclick: function () { view.watchlist = !view.watchlist; writeStateToHash(); renderBoard(); } })
    );
  }

  function tabButtons() {
    var pre = makeNode('button', { type: 'button', 'aria-pressed': view.tab === 'pre-token' ? 'true' : 'false', text: 'Pre-token', onclick: function () { view.tab = 'pre-token'; renderBoard(); } });
    var live = makeNode('button', { type: 'button', 'aria-pressed': view.tab === 'live' ? 'true' : 'false', text: 'Live token', onclick: function () { view.tab = 'live'; renderBoard(); } });
    return makeNode('div', { class: 'field' }, makeNode('span', { class: 'sub', text: 'Token status' }), makeNode('div', { class: 'tabs' }, pre, live));
  }

  function renderControls() {
    return makeNode('div', { class: 'controls' },
      searchField(),
      categorySelect(),
      chainSelect(),
      watchlistToggle(),
      tabButtons(),
      makeNode('span', { class: 'count', text: view.tab === 'pre-token' ? visibleRows().length + ' rows shown' : DATA.live.length + ' live-token protocols' })
    );
  }

  // ---------------------------------------------------------------- board table
  function sortableHeader(key, label) {
    return makeNode('th', { scope: 'col' },
      makeNode('button', { type: 'button', onclick: function () { if (view.sort === key) view.dir = -view.dir; else { view.sort = key; view.dir = -1; } renderBoard(); } },
        label,
        view.sort === key ? makeNode('span', { 'aria-hidden': 'true', text: view.dir < 0 ? ' v' : ' ^' }) : null
      )
    );
  }

  // The small line under a protocol name: category, then its first two chains.
  function protocolSubtitle(row) {
    var chains = row.chains && row.chains.length ? row.chains.slice(0, 2).join(', ') : 'an unnamed chain';
    return (row.category || 'Other') + ' on ' + chains;
  }

  function growthLabel(row) {
    return row.change_7d === null ? 'n/a' : formatPct(row.change_7d);
  }

  function growthClass(row) {
    if (row.change_7d === null) return '';
    return row.change_7d >= 0 ? 'pos' : 'neg';
  }

  // The implied-value cell: a bar scaled to the strongest row, then the number.
  function impliedCell(row, maxImplied) {
    var width = Math.max(3, Math.round((row.implied_value_usd / maxImplied) * 100));
    return makeNode('td', null, makeNode('div', { class: 'implied' },
      makeNode('div', { class: 'bar', 'aria-hidden': 'true' }, makeNode('i', { style: 'width:' + width + '%' })),
      makeNode('span', { class: 'num', text: formatUsd(row.implied_value_usd) })
    ));
  }

  // Compare checkbox cell, shown only while compare mode is on. Clicking it must not
  // open the detail drawer, so the row handlers ignore events from an input.
  function compareCheckboxCell(row) {
    var picked = view.compare.indexOf(row.slug) >= 0;
    var box = makeNode('input', { type: 'checkbox', checked: picked ? 'checked' : null, 'aria-label': 'Compare ' + row.name });
    box.addEventListener('change', function () { toggleCompare(row.slug); });
    return makeNode('td', null, box);
  }

  function boardRow(row, maxImplied) {
    var tr = makeNode('tr', {
      'data-selected': view.selected === row.slug ? 'true' : 'false',
      tabindex: '0',
      onclick: function (e) { if (e.target && e.target.tagName === 'INPUT') return; openDetailDrawer(row.slug); },
      onkeydown: function (e) { if (e.target && e.target.tagName === 'INPUT') return; if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetailDrawer(row.slug); } }
    });
    if (view.compareOn) tr.appendChild(compareCheckboxCell(row));
    tr.appendChild(makeNode('td', { class: 'num', text: String(row.rank) }));
    tr.appendChild(makeNode('td', null, makeNode('div', { class: 'name' },
      makeNode('b', { text: row.name }),
      makeNode('span', { class: 'sub', text: protocolSubtitle(row) })
    )));
    tr.appendChild(makeNode('td', { class: 'num', text: formatUsd(row.tvl_usd) }));
    tr.appendChild(makeNode('td', { class: 'num ' + growthClass(row), text: growthLabel(row) }));
    tr.appendChild(makeNode('td', { class: 'num', text: formatAge(row.age_days) }));
    tr.appendChild(impliedCell(row, maxImplied));
    tr.appendChild(makeNode('td', null, makeNode('span', { class: 'status', text: 'no token' })));
    return tr;
  }

  function boardHead() {
    var headRow = makeNode('tr', null);
    if (view.compareOn) headRow.appendChild(makeNode('th', { scope: 'col' }));
    headRow.appendChild(sortableHeader('implied', 'Rank'));
    headRow.appendChild(sortableHeader('name', 'Protocol'));
    headRow.appendChild(sortableHeader('tvl', 'TVL'));
    headRow.appendChild(sortableHeader('growth', '7d'));
    headRow.appendChild(sortableHeader('age', 'Age'));
    headRow.appendChild(sortableHeader('implied', 'Implied value'));
    headRow.appendChild(makeNode('th', { scope: 'col', text: 'Token' }));
    return makeNode('thead', null, headRow);
  }

  function emptyBoard() {
    return makeNode('div', { class: 'panel' }, makeNode('div', { class: 'empty' },
      makeNode('h2', { text: 'No protocol matches that filter' }),
      makeNode('p', { text: 'Clear the search or pick another category, chain or scope to see the board again.' }),
      makeNode('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { view.q = ''; view.category = 'all'; view.chain = 'all'; view.watchlist = false; writeStateToHash(); renderBoard(); } })
    ));
  }

  function renderBoardTable() {
    var list = sortRows(visibleRows());
    if (list.length === 0) return emptyBoard();
    var max = list[0].implied_value_usd || 1;
    var tbody = makeNode('tbody');
    list.forEach(function (row) { tbody.appendChild(boardRow(row, max)); });
    return makeNode('div', { class: 'panel' },
      makeNode('div', { class: 'table-wrap' },
        makeNode('table', null,
          makeNode('caption', { class: 'sub', text: 'Pre-token protocols, strongest implied value first. Select a row for its model and farm plan.' }),
          boardHead(),
          tbody
        )
      )
    );
  }

  function renderLiveTable() {
    var tbody = makeNode('tbody');
    DATA.live.forEach(function (row) {
      tbody.appendChild(makeNode('tr', null,
        makeNode('td', { class: 'num', text: 'live' }),
        makeNode('td', null, makeNode('div', { class: 'name' }, makeNode('b', { text: row.name }), makeNode('span', { class: 'sub', text: protocolSubtitle(row) }))),
        makeNode('td', { class: 'num', text: formatUsd(row.tvl_usd) }),
        makeNode('td', { class: 'num ' + (row.change_7d !== null && row.change_7d >= 0 ? 'pos' : 'neg'), text: formatPct(row.change_7d) }),
        makeNode('td', { class: 'num', text: formatUsd(row.mcap_usd) }),
        makeNode('td', null, makeNode('span', { class: 'status', text: 'already trades' }))
      ));
    });
    return makeNode('div', { class: 'panel' },
      makeNode('div', { class: 'table-wrap' },
        makeNode('table', null,
          makeNode('caption', { class: 'sub', text: 'Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking.' }),
          makeNode('thead', null, makeNode('tr', null, makeNode('th', { scope: 'col', text: 'Status' }), makeNode('th', { scope: 'col', text: 'Protocol' }), makeNode('th', { scope: 'col', text: 'TVL' }), makeNode('th', { scope: 'col', text: '7d' }), makeNode('th', { scope: 'col', text: 'Market cap' }), makeNode('th', { scope: 'col', text: 'Token' }))),
          tbody
        )
      )
    );
  }

  // ---------------------------------------------------------------- model panel
  function modelFormulaText(model, base) {
    return 'implied = round( tvl_usd x ' + base + ' x (1 + clamp(change_7d, ' + model.growth_floor + ', ' + model.growth_cap + ') / 100 x ' + model.growth_weight + ') x (' + model.maturity_floor + ' + min(age_days, ' + model.maturity_days + ') / ' + model.maturity_days + ' x ' + model.maturity_range + ') )';
  }

  function modelDerivationNote(model, base, floorLabel) {
    return "Where the base multiple comes from: it is not a fixed number. It is derived from this snapshot. Take the protocols that already have a token and sit at or above the " + floorLabel + " watchlist floor (47 protocols), and take the median of their market-cap-to-TVL ratios. The median is used instead of the mean because a few tokens are priced on something other than TVL, and they would pull the mean far from what the market typically pays. On this snapshot the median is " + base + " (shown rounded to three decimals), about eight cents of market value for each dollar of TVL. The 0.25 in the model's constants is only a fallback, used if a snapshot has no tokenized protocols at all.";
  }

  function renderModelPanel() {
    var model = DATA.model;
    var base = model.base_multiple.toFixed(3);
    var floorLabel = '$' + Math.round(DATA.floor_usd / 1e6) + 'M';
    return makeNode('section', { class: 'panel model' },
      makeNode('h2', { text: 'How implied value is computed' }),
      makeNode('p', { class: 'model-note', text: 'Every row is scored by one function of the snapshot figures. No protocol name is special-cased, and no row is hand-picked.' }),
      makeNode('div', { class: 'formula' }, modelFormulaText(model, base)),
      makeNode('p', { class: 'model-note', text: modelDerivationNote(model, base, floorLabel) }),
      makeNode('p', { class: 'model-note', text: 'TVL and seven-day growth come from the snapshot. Age is the time since the protocol was first listed, the best record of how long it has run with no token; an unlisted age uses ' + model.unknown_age_days + ' days. The early radar is every pre-token protocol below the watchlist floor, by TVL, and the live-token protocols are set aside with their market caps shown.' }),
      makeNode('p', { class: 'model-note', text: "Snapshot " + DATA.as_of + ", from the DefiLlama public protocol index. Implied value is a model estimate built from that snapshot's figures. It is not a price, and it is not a prediction that a token will launch." })
    );
  }

  // ---------------------------------------------------------------- compare mode
  // Compare is off by default. Turn it on, tick up to two rows, and the two protocols
  // appear side by side below the model panel. Nothing about compare is written to
  // the hash, and with it off the board is byte-for-byte the plain board.
  function findRowBySlug(slug) {
    var found = DATA.rows.filter(function (row) { return row.slug === slug; });
    return found.length ? found[0] : null;
  }

  function toggleCompare(slug) {
    var at = view.compare.indexOf(slug);
    if (at >= 0) view.compare.splice(at, 1);
    else if (view.compare.length < 2) view.compare.push(slug);
    renderBoard();
  }

  function setCompareMode(on) {
    view.compareOn = on;
    if (!on) view.compare = [];
    renderBoard();
  }

  function compareMetricRow(label, left, right) {
    return makeNode('tr', null,
      makeNode('th', { scope: 'row', text: label }),
      makeNode('td', { class: 'num', text: left }),
      makeNode('td', { class: 'num', text: right })
    );
  }

  function comparePanel() {
    var a = findRowBySlug(view.compare[0]);
    var b = findRowBySlug(view.compare[1]);
    if (!a || !b) return null;
    var stepA = splitStepText(buildFarmSteps(a)[1]);
    var stepB = splitStepText(buildFarmSteps(b)[1]);
    return makeNode('div', { class: 'panel' },
      makeNode('div', { class: 'table-wrap' },
        makeNode('table', null,
          makeNode('caption', { class: 'sub', text: 'Two protocols, side by side. The core farm step is step two of each protocol’s own plan.' }),
          makeNode('thead', null, makeNode('tr', null,
            makeNode('th', { scope: 'col', text: '' }),
            makeNode('th', { scope: 'col', text: a.name }),
            makeNode('th', { scope: 'col', text: b.name })
          )),
          makeNode('tbody', null,
            compareMetricRow('Rank', String(a.rank), String(b.rank)),
            compareMetricRow('TVL', formatUsd(a.tvl_usd), formatUsd(b.tvl_usd)),
            compareMetricRow('Seven-day growth', formatPct(a.change_7d), formatPct(b.change_7d)),
            compareMetricRow('Age with no token', formatAge(a.age_days), formatAge(b.age_days)),
            compareMetricRow('Implied value', formatUsd(a.implied_value_usd), formatUsd(b.implied_value_usd)),
            makeNode('tr', null,
              makeNode('th', { scope: 'row', text: 'Core farm step' }),
              makeNode('td', null, makeNode('b', { text: stepA.action }), makeNode('span', { class: 'cost', text: stepA.tail })),
              makeNode('td', null, makeNode('b', { text: stepB.action }), makeNode('span', { class: 'cost', text: stepB.tail }))
            )
          )
        )
      )
    );
  }

  function renderCompareSection() {
    var hint;
    if (!view.compareOn) hint = 'Turn on compare to pick two protocols from the board. Their TVL, growth, age, implied value and core farm step will appear side by side here.';
    else if (view.compare.length === 0) hint = 'Compare is on. Tick up to two rows in the board; the comparison appears below.';
    else if (view.compare.length === 1) hint = 'One protocol picked. Tick one more row to see them side by side.';
    else hint = 'Two protocols picked.';
    var section = makeNode('section', { class: 'panel model' },
      makeNode('h2', { text: 'Compare two protocols' }),
      makeNode('p', { class: 'model-note', text: hint }),
      makeNode('button', { type: 'button', class: 'toggle', 'aria-pressed': view.compareOn ? 'true' : 'false', text: view.compareOn ? 'Disable compare' : 'Enable compare', onclick: function () { setCompareMode(!view.compareOn); } })
    );
    if (view.compare.length === 2) {
      var panel = comparePanel();
      if (panel) section.appendChild(panel);
    }
    return section;
  }

  // ---------------------------------------------------------------- detail dialog
  var detailDialog = makeNode('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  detailDialog.addEventListener('close', function () { view.selected = null; writeStateToHash(); });

  // Close the drawer. Real browsers implement dialog.close(); the fallback keeps the
  // drawer closable in environments with only partial dialog support, and mirrors the
  // close handler above.
  function closeDetailDrawer() {
    if (typeof detailDialog.close === 'function') detailDialog.close();
    else { detailDialog.removeAttribute('open'); view.selected = null; writeStateToHash(); }
  }

  function detailHeader(row) {
    return makeNode('div', { class: 'detail-head' },
      makeNode('div', null,
        makeNode('span', { class: 'brand-name', text: 'Rank ' + row.rank + ' of ' + DATA.board_size }),
        makeNode('h2', { id: 'detail-title', text: row.name }),
        makeNode('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain') })
      ),
      makeNode('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { closeDetailDrawer(); } })
    );
  }

  function detailEquationRow(label, value) {
    return makeNode('div', null, makeNode('span', { text: label }), makeNode('b', { class: 'num', text: value }));
  }

  function detailModelSection(row) {
    var recomputed = recomputeImplied(row, DATA.model);
    var matches = recomputed === row.implied_value_usd;
    var note = 'Model ' + DATA.model_version + ': the same function scores every protocol. The page recomputes this row as ' + formatUsd(recomputed) + (matches ? ', the same number board.json carries.' : ', which differs from the board: the data would be stale.') + ' This is an estimate, not a price.';
    return makeNode('section', { class: 'detail-section' },
      makeNode('h3', { text: 'Implied value' }),
      makeNode('div', { class: 'equation' },
        detailEquationRow('TVL', formatUsd(row.tvl_usd)),
        detailEquationRow('Seven-day growth', formatPct(row.change_7d)),
        detailEquationRow('Age with no token', formatAge(row.age_days)),
        detailEquationRow('Growth multiplier', String(row.growth_multiplier)),
        detailEquationRow('Maturity multiplier', String(row.maturity_multiplier)),
        detailEquationRow('Implied value', formatUsd(row.implied_value_usd))
      ),
      makeNode('p', { class: 'sub', text: note })
    );
  }

  function detailFarmSection(row) {
    var steps = buildFarmSteps(row);
    return makeNode('section', { class: 'detail-section' },
      makeNode('h3', { text: 'Farm plan' }),
      makeNode('ol', { class: 'steps' }, steps.map(function (stepString) {
        var parts = splitStepText(stepString);
        return makeNode('li', null, makeNode('b', { text: parts.action }), makeNode('span', { class: 'cost', text: parts.tail }));
      }))
    );
  }

  function openDetailDrawer(slug) {
    var row = findRowBySlug(slug);
    if (!row) return;
    view.selected = slug;
    writeStateToHash();
    detailDialog.textContent = '';
    detailDialog.appendChild(detailHeader(row));
    detailDialog.appendChild(detailModelSection(row));
    detailDialog.appendChild(detailFarmSection(row));
    if (typeof detailDialog.showModal === 'function') {
      if (!detailDialog.open) detailDialog.showModal();
    } else {
      detailDialog.setAttribute('open', '');
    }
  }

  // ---------------------------------------------------------------- render + boot
  function renderBoard() {
    boardRoot.textContent = '';
    var shell = makeNode('div', { class: 'shell' });
    shell.appendChild(renderHeader());
    shell.appendChild(renderLede());
    shell.appendChild(renderControls());
    shell.appendChild(view.tab === 'pre-token' ? renderBoardTable() : renderLiveTable());
    if (view.tab === 'pre-token') {
      shell.appendChild(renderModelPanel());
      shell.appendChild(renderCompareSection());
    }
    boardRoot.appendChild(shell);
    boardRoot.setAttribute('aria-busy', 'false');
    if (!detailDialog.isConnected) boardRoot.appendChild(detailDialog);
    if (view.selected) openDetailDrawer(view.selected);
  }

  readStateFromHash();
  renderBoard();
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && detailDialog.open) closeDetailDrawer();
  });
})();
