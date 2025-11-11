// ==UserScript==
// @name         TikTok 广告系列助手
// @namespace    http://tampermonkey.net/
// @version      3.2
// @description  V3.2: 修复V3.1中预算采集抓成系列名称的BUG。改用更精确的CSS Class选择器 (.campaign-budget-editor-text-content)。
// @author       Taoo
// @match        *://ads.tiktok.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function() {
    'use strict';

    // 全局变量
    window.ttHelperPanelData = [];
    let currentPanelSort = { key: '', dir: 'asc' };
    let tableObserver = null;
    let scrapeDebounceTimer = null;
    let scrapeBcAttempted = false;

    // --- 1. 配置选择器 (V3.2) ---
    const SELECTORS = {
        ACCT_NAME: '.advertiser_name',
        CREATE_CAMPAIGN_NAME_INPUT: 'input[data-testid="campaign_settings_name"]',
        CREATE_CONTINUE_BTN: 'button[data-testid="common_next_button"]',
        LIST_CAMPAIGN_NAME_SPAN: '.item-content[data-testid^="common-table-item-display-"]',
        LIST_CAMPAIGN_STATUS_SPAN: 'div.primary-status > span',

        // V3.2: 修复!
        // V3.1 的 data-testid 不唯一, 会抓到系列名称。
        // V3.2 改用您 HTML 中提供的 'campaign-budget-editor-text-content'
        LIST_CAMPAIGN_BUDGET: '.campaign-budget-editor-text-content',

        LIST_ROW_GUESS: '.row-item',
        TABLE_BODY_AREA: '.body-area',

        // V3.0: BC 采集器 (在页面加载时采集这些选择器)
        BC_PANEL_CONTENT: '.account-panel', // 弹窗根元素
        BC_PANEL_SECTION: '.account-panel-section',
        BC_NAME: '.section-title', // 我们等待这个元素出现在 DOM 中
        BC_ACC_ITEM: '.account-panel-info-item',
        BC_ACC_NAME: '.role-name', // 账户名
        BC_ACC_ID: '.title-info-id'
    };

    // --- 2. 数据库核心功能 (V3.1) ---
    const DB_KEY = 'ttAdDatabase';
    function loadDb() { return GM_getValue(DB_KEY, {}); }
    function saveDb(db) { GM_setValue(DB_KEY, db); }

    // V3.1: 新增 budget 参数
    function saveCampaign(db, accountId, accountName, campaignName, status, budget) {
        if (!accountId || !campaignName || !accountName || accountName === 'undefined') return false;

        if (!db[accountId]) {
            db[accountId] = { accountName: accountName, campaigns: {} };
        }
        db[accountId].accountName = accountName;

        if (!db[accountId].campaigns[campaignName]) {
             db[accountId].campaigns[campaignName] = {};
        }

        if (status && status !== '未知') {
             db[accountId].campaigns[campaignName].status = status;
        } else if (!db[accountId].campaigns[campaignName].status) {
             db[accountId].campaigns[campaignName].status = '未知';
        }

        // V3.1: 保存预算
        if (budget) {
            db[accountId].campaigns[campaignName].budget = budget;
        }

        return true;
    }

    function saveBcData(db, accId, accName, bcName) {
         if (!accId || !bcName || !accName) return;

         if (!db[accId]) {
             db[accId] = { campaigns: {} };
         }
         db[accId].bcName = bcName;
         db[accId].accountName = accName; // 确保户名被保存
         console.log(`[TT助手] V3.2: 已关联BC: ${bcName} -> ${accName} (${accId})`);
    }

    // --- 3. 页面逻辑：新建页面 (V2.1) ---
    function initCreatePage() {
        console.log('[TT助手] V3.2 新建页面脚本加载...');
        waitForElement(SELECTORS.ACCT_NAME, (acctNameElement) => {
            const accountName = acctNameElement.textContent.trim();
            const accountId = new URLSearchParams(window.location.search).get('aadvid');
            if (!accountId || !accountName) return;

            waitForElement(SELECTORS.CREATE_CONTINUE_BTN, (btn) => {
                btn.addEventListener('click', () => {
                    try {
                        const campaignName = document.querySelector(SELECTORS.CREATE_CAMPAIGN_NAME_INPUT)?.value.trim();
                        if (campaignName) {
                            const db = loadDb();
                            // V3.1: 新建的系列没有预算, 传入 null
                            saveCampaign(db, accountId, accountName, campaignName, '投放中 (新建)', null);
                            saveDb(db);
                            console.log('[TT助手] V3.2 新建系列已保存!');
                        }
                    } catch (e) { console.error('[TT助手] 保存新建系列时出错:', e); }
                });
            });
        });
    }

    // --- 4. 页面逻辑：列表页面 (V3.2) ---
    function initListPage() {
        const currentUrlParams = new URLSearchParams(window.location.search);
        const currentLevel = currentUrlParams.get('level') || 'campaign';

        if (currentLevel !== 'campaign') {
            console.log(`[TT助手] V3.2: 检测到 ${currentLevel} 标签页, 跳过采集。`);
            return;
        }

        console.log('[TT助手] V3.2 列表页(Campaign)加载, 等待户名称...');

        waitForElement(SELECTORS.ACCT_NAME, (acctNameElement) => {
            console.log(`[TT助手] 户名称已加载, 等待系列列表...`);

            waitForElement(SELECTORS.LIST_CAMPAIGN_NAME_SPAN, () => {
                console.log('[TT助手] V3.2 列表已加载，开始采集...');
                try {
                    const accountName = acctNameElement.textContent.trim();
                    const accountId = new URLSearchParams(window.location.search).get('aadvid');
                    if (!accountId) return;

                    const db = loadDb();
                    let savedCount = 0;
                    const nameSpans = document.querySelectorAll(SELECTORS.LIST_CAMPAIGN_NAME_SPAN);

                    nameSpans.forEach(nameSpan => {
                        const campaignName = nameSpan.textContent.trim();
                        if (!campaignName) return;

                        const row = nameSpan.closest(SELECTORS.LIST_ROW_GUESS);
                        if (row) {
                            const statusSpan = row.querySelector(SELECTORS.LIST_CAMPAIGN_STATUS_SPAN);
                            const status = statusSpan ? statusSpan.textContent.trim() : '未知';

                            // V3.2: 采集预算
                            let budget = 'N/A';
                            try {
                                // V3.2 修复: 使用新的、精确的选择器
                                const budgetSpan = row.querySelector(SELECTORS.LIST_CAMPAIGN_BUDGET);
                                if(budgetSpan) {
                                    // .textContent 会抓取所有子元素, 包括 "不限"
                                    budget = budgetSpan.textContent.trim();
                                }
                            } catch (e) {
                                console.warn(`[TT助手] V3.2: 预算选择器 ${SELECTORS.LIST_CAMPAIGN_BUDGET} 无效或已更改。`, e);
                            }

                            // V3.1: 保存所有数据
                            if (saveCampaign(db, accountId, accountName, campaignName, status, budget)) {
                                savedCount++;
                            }
                        }
                    });

                    if (savedCount > 0) {
                        saveDb(db);
                        console.log(`[TT助手] V3.2 采集完成, 共保存/更新 ${savedCount} 条数据 (含预算)。`);
                    }
                } catch (e) {
                    console.error('[TT助手] V3.2 采集列表页时出错:', e);
                }
            });
        });
    }

    // --- V3.0: BC 采集器 (页面加载时采集) ---
    function initiateBcScrapeOnLoad() {
        if (scrapeBcAttempted) {
            return;
        }
        scrapeBcAttempted = true;

        console.log('[TT助手] V3.2: 启动BC采集器 (On-Load 模式)...');

        waitForElement(SELECTORS.BC_NAME, (bcNameElement) => {

            console.log('[TT助手] V3.2: 检测到BC面板已在DOM中渲染 (找到BC Name)。');
            const panelRoot = bcNameElement.closest(SELECTORS.BC_PANEL_CONTENT);

            if (panelRoot) {
                console.log('[TT助手] V3.2: 找到 .account-panel, 立即采集...');
                scrapeBCData(panelRoot);
            } else {
                console.error('[TT助手] V3.2: 找到了BC Name, 但找不到父级 .account-panel。采集失败。');
            }

        }, 15000, 500); // 15秒超时, 500ms轮询
    }


    // V2.4: scrapeBCData (此函数 V3.0 已修复, 无需改动)
    function scrapeBCData(popoverElement) {
        try {
            const db = loadDb();
            let savedCount = 0;
            const bcSections = popoverElement.querySelectorAll(SELECTORS.BC_PANEL_SECTION);

            if (bcSections.length === 0) {
                 console.warn('[TT助手] V3.2: 采集到0个BC section, 可能是选择器已更改。');
                 return;
            }

            console.log(`[TT助手] V3.2: 找到 ${bcSections.length} 个BC区块, 开始遍历...`);

            bcSections.forEach(section => {
                const bcNameEl = section.querySelector(SELECTORS.BC_NAME);
                const bcName = bcNameEl ? bcNameEl.textContent.trim() : null;
                if (!bcName) {
                    console.warn('[TT助手] V3.2: 找到一个BC区块, 但未找到BC名称。');
                    return;
                }

                const accounts = section.querySelectorAll(SELECTORS.BC_ACC_ITEM);
                accounts.forEach(account => {
                    const accNameEl = account.querySelector(SELECTORS.BC_ACC_NAME);
                    const accIdEl = account.querySelector(SELECTORS.BC_ACC_ID);

                    if (accNameEl && accIdEl) {
                        const accName = accNameEl.textContent.trim();
                        let accId = accIdEl.textContent.trim();
                        accId = accId.replace("ID:", "").trim();

                        saveBcData(db, accId, accName, bcName);
                        savedCount++;
                    }
                });
            });

            if (savedCount > 0) {
                saveDb(db);
                console.log(`[TT助手] V3.2: BC 采集完成, 关联 ${savedCount} 个账户。`);
                if (document.getElementById('tt-helper-panel') && document.getElementById('tt-helper-panel').style.display === 'flex') {
                    showSearchPanel();
                }
            } else {
                 console.warn('[TT助手] V3.2: BC 采集器运行了, 但未找到0条BC/账户信息。');
            }
        } catch (e) {
             console.error('[TT助手] V3.2 BC 采集出错:', e);
        }
    }


    // --- 5. UI 界面 (V3.1) ---
    function addControls() {
        if (document.getElementById('tt-helper-panel')) return;

        GM_addStyle(`
            #tt-helper-btn {
                position: fixed; z-index: 9998;
                top: 50%; right: 20px;
                transform: translateY(-50%);
                background-color: #007bff; color: white; border: none;
                border-radius: 50%; width: 50px; height: 50px;
                font-size: 24px; cursor: move;
                box-shadow: 0 4px 10px rgba(0,0,0,0.2);
            }
            #tt-helper-panel {
                position: fixed; z-index: 9999; top: 50%; left: 50%;
                transform: translate(-50%, -50%);
                width: 1200px; max-height: 85vh;
                background: white; border-radius: 8px; box-shadow: 0 10px 30px rgba(0,0,0,0.3);
                display: none; flex-direction: column; padding: 20px; font-family: sans-serif;
            }
            #tt-helper-panel h3 { margin-top: 0; }
            #tt-panel-global-search {
                width: 100%; padding: 10px; box-sizing: border-box;
                font-size: 16px; margin-bottom: 15px; border-radius: 4px;
                border: 1px solid #007bff; background-color: #f0f8ff;
            }
            #tt-panel-filters {
                display: grid;
                grid-template-columns: repeat(6, 1fr); /* V3.1: 增加到 6 列 */
                gap: 10px;
                margin-bottom: 15px;
            }
            #tt-panel-filters input {
                padding: 8px; font-size: 14px; width: 100%;
                box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px;
            }
            #tt-helper-results {
                max-height: 60vh;
                overflow: auto;
                border: 1px solid #eee;
            }
            #tt-helper-results table { width: 100%; border-collapse: collapse; }
            #tt-helper-results th, #tt-helper-results td {
                border-bottom: 1px solid #ddd; padding: 8px 12px; text-align: left;
                white-space: nowrap;
            }
            #tt-helper-results th {
                background: #f9f9f9; position: sticky; top: 0;
            }
            #tt-helper-results th[data-sort] { cursor: pointer; }
            #tt-helper-results th[data-sort]:after { content: ' \\25B2'; opacity: 0.3; }
            #tt-helper-results th[data-sort-dir='asc']:after { content: ' \\25B2'; opacity: 1; }
            #tt-helper-results th[data-sort-dir='desc']:after { content: ' \\25BC'; opacity: 1; }
            .tt-helper-controls { margin-top: 15px; display: flex; justify-content: space-between; align-items: center; }
            .tt-helper-btn { padding: 8px 15px; border: none; border-radius: 5px; cursor: pointer; color: white; }
            .tt-helper-btn-export { background-color: #28a745; }
            .tt-helper-btn-clear { background-color: #f0ad4e; margin-left: 10px; }
            .tt-helper-btn-close { background-color: #dc3545; }
            .tt-status-green { color: #28a745; font-weight: bold; }
            .tt-status-gray { color: #6c757d; }
            .tt-status-red { color: #dc3545; font-weight: bold; }
        `);

        const btn = document.createElement('button');
        btn.id = 'tt-helper-btn';
        btn.innerHTML = '搜';
        btn.title = '搜索广告系列';

        const savedPos = GM_getValue('ttHelperBtnPos', null);
        if (savedPos) {
            btn.style.top = savedPos.top;
            btn.style.right = 'auto';
            btn.style.left = savedPos.left;
            btn.style.transform = 'none';
        }

        document.body.appendChild(btn);
        btn.addEventListener('click', (e) => {
            if (btn.dataset.isDragging === 'true') {
                e.stopPropagation();
                return;
            }
            showSearchPanel();
        });

        makeDraggable(btn);

        const panel = document.createElement('div');
        panel.id = 'tt-helper-panel';
        panel.innerHTML = `
            <h3>TikTok 广告系列助手 (V3.2)</h3>
            <input type="text" id="tt-panel-global-search" placeholder="全局搜索 (搜索所有列)...">
            <div id="tt-panel-filters">
                <input type="text" id="tt-panel-filter-bc" placeholder="筛选BC名称...">
                <input type="text" id="tt-panel-filter-name" placeholder="筛选账户名称...">
                <input type="text" id="tt-panel-filter-id" placeholder="筛选账户ID...">
                <input type="text" id="tt-panel-filter-campaign" placeholder="筛选系列名称...">
                <input type="text" id="tt-panel-filter-status" placeholder="筛选状态...">
                <input type="text" id="tt-panel-filter-budget" placeholder="筛选预算...">
            </div>
            <div id="tt-helper-results">
                <table id="tt-panel-table">
                    <thead>
                        <tr>
                            <th data-sort="bcName">BC 名称</th>
                            <th data-sort="name">账户名称</th>
                            <th data-sort="id">账户ID</th>
                            <th data-sort="campaign">推广系列</th>
                            <th data-sort="status">状态</th>
                            <th data-sort="budget">预算</th>
                        </tr>
                    </thead>
                    <tbody id="tt-panel-tbody"></tbody>
                </table>
            </div>
            <div class="tt-helper-controls">
                <span>
                    <button class="tt-helper-btn tt-helper-btn-export">导出为 CSV</button>
                    <button class="tt-helper-btn tt-helper-btn-clear" id="tt-helper-clear-data" title="清除所有本地存储的数据">清除数据</button>
                </span>
                <button class="tt-helper-btn tt-helper-btn-close">关闭</button>
            </div>
        `;
        document.body.appendChild(panel);

        panel.querySelector('.tt-helper-btn-close').addEventListener('click', () => panel.style.display = 'none');
        panel.querySelector('.tt-helper-btn-export').addEventListener('click', exportToCsv);
        panel.querySelector('#tt-helper-clear-data').addEventListener('click', clearAllData);

        const renderFunc = () => renderPanelTable(window.ttHelperPanelData);
        panel.querySelector('#tt-panel-global-search').addEventListener('input', renderFunc);
        panel.querySelector('#tt-panel-filter-bc').addEventListener('input', renderFunc);
        panel.querySelector('#tt-panel-filter-name').addEventListener('input', renderFunc);
        panel.querySelector('#tt-panel-filter-id').addEventListener('input', renderFunc);
        panel.querySelector('#tt-panel-filter-campaign').addEventListener('input', renderFunc);
        panel.querySelector('#tt-panel-filter-status').addEventListener('input', renderFunc);
        panel.querySelector('#tt-panel-filter-budget').addEventListener('input', renderFunc); // V3.1: 绑定预算筛选

        panel.querySelectorAll('#tt-panel-table th[data-sort]').forEach(th => {
            th.addEventListener('click', () => sortPanelTable(th));
        });
    }

    // V1.9 拖动
    function makeDraggable(el) { /* ... (代码同V1.9, 已折叠) ... */
        let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
        el.dataset.isDragging = 'false';
        el.onmousedown = dragMouseDown;
        function dragMouseDown(e) {
            e = e || window.event; e.preventDefault();
            pos3 = e.clientX; pos4 = e.clientY;
            el.dataset.isDragging = 'false';
            document.onmouseup = closeDragElement;
            document.onmousemove = elementDrag;
        }
        function elementDrag(e) {
            e = e || window.event; e.preventDefault();
            el.dataset.isDragging = 'true';
            pos1 = pos3 - e.clientX; pos2 = pos4 - e.clientY;
            pos3 = e.clientX; pos4 = e.clientY;
            let newTop = el.offsetTop - pos2;
            let newLeft = el.offsetLeft - pos1;
            newTop = Math.max(0, Math.min(newTop, window.innerHeight - el.offsetHeight));
            newLeft = Math.max(0, Math.min(newLeft, window.innerWidth - el.offsetWidth));
            el.style.top = newTop + "px";
            el.style.left = newLeft + "px";
            el.style.right = 'auto'; el.style.transform = 'none';
        }
        function closeDragElement() {
            document.onmouseup = null; document.onmousemove = null;
            GM_setValue('ttHelperBtnPos', { top: el.style.top, left: el.style.left });
            setTimeout(() => { el.dataset.isDragging = 'false'; }, 0);
        }
    }

    // V2.2: 弹窗 (全局)
    function showSearchPanel() {
        let panel = document.getElementById('tt-helper-panel');
        if (!panel) {
            addControls();
            panel = document.getElementById('tt-helper-panel');
        }

        const db = loadDb();
        window.ttHelperPanelData = flattenDb(db);

        currentPanelSort = { key: '', dir: 'asc' };
        panel.querySelector('#tt-panel-global-search').value = '';
        panel.querySelectorAll('#tt-panel-filters input').forEach(input => input.value = '');
        panel.querySelectorAll('#tt-panel-table th').forEach(th => th.removeAttribute('data-sort-dir'));

        renderPanelTable(window.ttHelperPanelData);

        panel.style.display = 'flex';
    }

    // V1.8 标准化
    function normalizeSearchString(str) {
        if (!str) return '';
        return str.toLowerCase().replace(/\s/g, '');
    }

    // V3.1: 扁平化数据库
    function flattenDb(db) {
        const flatData = [];
        for (const accountId in db) {
            const account = db[accountId];
            if (Object.keys(account.campaigns || {}).length === 0) {

                // V3.1: 根据用户请求, 隐藏没有推广系列的 "N/A" 行
                if (account.bcName || account.accountName) {
                    /*
                    flatData.push({
                        id: accountId,
                        name: account.accountName || 'N/A',
                        bcName: account.bcName || 'N/A',
                        campaign: 'N/A',
                        status: 'N/A',
                        budget: 'N/A' // V3.1 add
                    });
                    */
                }

            } else {
                for (const campaignName in account.campaigns) {
                    const campaign = account.campaigns[campaignName] || {};
                    flatData.push({
                        id: accountId,
                        name: account.accountName,
                        bcName: account.bcName || 'N/A',
                        campaign: campaignName,
                        status: campaign.status || '未知',
                        budget: campaign.budget || 'N/A' // V3.1 NEW
                    });
                }
            }
        }
        return flatData;
    }

    // V3.1: 渲染数据
    function renderPanelTable(data) {
        const tbody = document.getElementById('tt-panel-tbody');
        if (!tbody) return;

        const filteredData = applyPanelFilters(data);

        tbody.innerHTML = '';
        if (filteredData.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6">没有找到数据</td></tr>'; // V3.1: Colspan 6
            return;
        }

        filteredData.forEach(r => {
            const tr = document.createElement('tr');
            const statusClass = getStatusClass(r.status);
            tr.innerHTML = `
                <td>${r.bcName || 'N/A'}</td>
                <td>${r.name || '<span style="color: #aaa;">未采集</span>'}</td>
                <td>${r.id}</td>
                <td>${r.campaign}</td>
                <td><span class="${statusClass}">${r.status}</span></td>
                <td>${r.budget || 'N/A'}</td>
            `;
            tbody.appendChild(tr);
        });
    }

    // V3.1: 筛选
    function applyPanelFilters(data) {
        const fGlobal = normalizeSearchString(document.getElementById('tt-panel-global-search').value);
        const fBcName = normalizeSearchString(document.getElementById('tt-panel-filter-bc').value);
        const fName = normalizeSearchString(document.getElementById('tt-panel-filter-name').value);
        const fId = normalizeSearchString(document.getElementById('tt-panel-filter-id').value);
        const fCampaign = normalizeSearchString(document.getElementById('tt-panel-filter-campaign').value);
        const fStatus = normalizeSearchString(document.getElementById('tt-panel-filter-status').value);
        const fBudget = normalizeSearchString(document.getElementById('tt-panel-filter-budget').value); // V3.1 NEW

        const currentData = data || window.ttHelperPanelData;

        const filteredData = currentData.filter(r => {
            const bcName = normalizeSearchString(r.bcName);
            const name = normalizeSearchString(r.name);
            const id = normalizeSearchString(r.id);
            const campaign = normalizeSearchString(r.campaign);
            const status = normalizeSearchString(r.status);
            const budget = normalizeSearchString(r.budget); // V3.1 NEW

            const globalMatch = fGlobal === '' ||
                                bcName.includes(fGlobal) ||
                                name.includes(fGlobal) ||
                                id.includes(fGlobal) ||
                                campaign.includes(fGlobal) ||
                                status.includes(fGlobal) ||
                                budget.includes(fGlobal); // V3.1 NEW

            const columnMatch = bcName.includes(fBcName) &&
                                name.includes(fName) &&
                                id.includes(fId) &&
                                campaign.includes(fCampaign) &&
                                status.includes(fStatus) &&
                                budget.includes(fBudget); // V3.1 NEW

            return globalMatch && columnMatch;
        });

        return filteredData;
    }

    // V3.1: 排序
    function sortPanelTable(th) {
        const key = th.dataset.sort;
        let dir = 'asc';

        if (th.dataset.sortDir === 'asc') {
            dir = 'desc';
        }

        document.querySelectorAll('#tt-panel-table th').forEach(h => h.removeAttribute('data-sort-dir'));
        th.dataset.sortDir = dir;

        const filteredData = applyPanelFilters(window.ttHelperPanelData);

        const sortedData = filteredData.sort((a, b) => {
            let valA, valB;
            switch(key) {
                case 'bcName': valA = a.bcName; valB = b.bcName; break;
                case 'name': valA = a.name; valB = b.name; break;
                case 'id': valA = a.id; valB = b.id; break;
                case 'campaign': valA = a.campaign; valB = b.campaign; break;
                case 'status': valA = a.status; valB = b.status; break;
                case 'budget': valA = a.budget; valB = b.budget; break; // V3.1 NEW
                default: return 0;
            }

            // V3.2 排序修复: 处理 "不限" 和 "$50.00" 这样的混合排序
            const numA = parseFloat(String(valA).replace(/[$,不限N/A]/g, '').trim()) || 0;
            const numB = parseFloat(String(valB).replace(/[$,不限N/A]/g, '').trim()) || 0;
            const strA = normalizeSearchString(valA);
            const strB = normalizeSearchString(valB);

            // 优先按数字排, 如果数字相同, 按字符串排
            const compare = numA - numB;
            const strCompare = strA.localeCompare(strB);

            if (compare !== 0) {
                 return dir === 'asc' ? compare : -compare;
            } else {
                 return dir === 'asc' ? strCompare : -strCompare;
            }
        });

        renderPanelTable(sortedData);
    }

    // V1.4 状态颜色
    function getStatusClass(statusText) {
        if (!statusText) return '';
        if (statusText.includes('投放中')) return 'tt-status-green';
        if (statusText.includes('已暂停')) return 'tt-status-gray';
        if (statusText.includes('未投放') || statusText.includes('已关闭') || statusText.includes('已封禁') || statusText.includes('不投放') || statusText.includes('受限')) {
            return 'tt-status-red';
        }
        return '';
    }

    // V3.1: 导出
    function exportToCsv() {
        const db = loadDb();
        const flatData = flattenDb(db);

        // V3.1: 增加预算列
        let csvContent = "data:text/csv;charset=utf-8,BC 名称,户名称,ID,推广系列名称,状态,预算\n";

        flatData.sort((a, b) => {
            const bcComp = (a.bcName || 'N/A').localeCompare(b.bcName || 'N/A');
            if (bcComp !== 0) return bcComp;
            if (a.id !== b.id) return a.id.localeCompare(b.id);
            return (a.campaign || 'N/A').localeCompare(b.campaign || 'N/A');
        });

        let lastBcName = null;
        let lastId = null;
        flatData.forEach(r => {
            const cleanBcName = `"${(r.bcName || 'N/A').replace(/"/g, '""')}"`;
            const cleanAcctName = `"${(r.name || '').replace(/"/g, '""')}"`;
            const cleanId = `"${r.id}"`;
            const cleanName = `"${(r.campaign || '').replace(/"/g, '""')}"`;
            const cleanStatus = `"${(r.status || '').replace(/"/g, '""')}"`;
            const cleanBudget = `"${(r.budget || '').replace(/"/g, '""')}"`; // V3.1 NEW

            if (r.bcName !== lastBcName) {
                csvContent += `${cleanBcName},${cleanAcctName},${cleanId},${cleanName},${cleanStatus},${cleanBudget}\n`; // V3.1
                lastBcName = r.bcName;
                lastId = r.id;
            } else if (r.id !== lastId) {
                csvContent += `,${cleanAcctName},${cleanId},${cleanName},${cleanStatus},${cleanBudget}\n`; // V3.1
                lastId = r.id;
            } else {
                csvContent += `,,,${cleanName},${cleanStatus},${cleanBudget}\n`; // V3.1
            }
        });

        const encodedUri = encodeURI(csvContent);
        const link = document.createElement('a');
        link.setAttribute('href', encodedUri);
        link.setAttribute('download', 'tiktok_campaigns_all.csv');
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        console.log('[TT助手] CSV 已导出');
    }

    // V2.0 清除数据
    function clearAllData() {
        if (confirm("您确定要清除所有已采集的数据吗？\n\n这个操作无法撤销，将清空本地存储的所有BC、户和系列信息。")) {
            try {
                GM_setValue(DB_KEY, {}); // 清空数据库
                console.log('[TT助手] 数据库已清除。');
                showSearchPanel(); // 刷新弹窗
            } catch (e) {
                console.error('[TT助手] 清除数据时出错:', e);
            }
        }
    }

    // V3.0: 修复 waitForElement, 不再检查可见性
    function waitForElement(selector, callback, timeout = 30000, interval = 500) {
        let elapsedTime = 0;
        const timer = setInterval(() => {
            const el = document.querySelector(selector);

            elapsedTime += interval;
            if (el) {
                clearInterval(timer);
                if (callback) callback(el);
            } else if (elapsedTime >= timeout) {
                clearInterval(timer);
                console.warn(`[TT助手] V3.2: 等待 ${selector} (在DOM中) 超时`);
            }
        }, interval);
    }

    // V2.1 表格监听器
    function attachTableObserver() {
        if (tableObserver) tableObserver.disconnect();

        waitForElement(SELECTORS.TABLE_BODY_AREA, (tableBody) => {
            console.log('[TT助手] V3.2: 成功附加表格监听器 (用于状态自动更新)。');

            tableObserver = new MutationObserver((mutations) => {
                const params = new URLSearchParams(window.location.search);
                const level = params.get('level') || 'campaign';
                if (level !== 'campaign') return;

                clearTimeout(scrapeDebounceTimer);
                scrapeDebounceTimer = setTimeout(() => {
                    console.log('[TT助手] V3.2: 检测到表格状态变化，将自动在后台重新采集...');
                    initListPage();
                }, 2000);
            });

            tableObserver.observe(tableBody, {
                subtree: true,
                characterData: true,
                childList: true
            });

        }, 10000);
    }


    // --- 7. 脚本启动入口 (V3.1 修复) ---

    // V2.4: 全局创建UI和菜单
    addControls();
    GM_registerMenuCommand('TikTok 助手: 查看数据', showSearchPanel);

    // 1. 显示"搜"按钮
    const btn = document.getElementById('tt-helper-btn');
    if (btn) btn.style.display = 'block';

    // 2. 启动采集和监听器 (V3.0 简化)
    const urlObserver = new MutationObserver((mutationsList, observer) => {
        // 确保UI在导航后依然存在
        if (!document.getElementById('tt-helper-panel')) {
            addControls();
            const btn = document.getElementById('tt-helper-btn');
            if (btn) btn.style.display = 'block';
        }

        // V3.1 修复: 每次导航重置BC采集标志
        // (V3.0 的 'scrapeBcAttempted' 标志会阻止在SPA导航后再次采集, 这是个BUG)
        scrapeBcAttempted = false;

        const url = window.location.href;
        const currentPage = document.body.dataset.ttHelperPage;

        const currentUrlParams = new URLSearchParams(window.location.search);
        const currentLevel = currentUrlParams.get('level') || 'campaign';
        const isCampaignLevel = !currentLevel || currentLevel === 'campaign';

        // 断开旧的表格监听器
        if (tableObserver) {
            tableObserver.disconnect();
            tableObserver = null;
        }

        // V3.0: 核心修复!
        initiateBcScrapeOnLoad();

        // 页面逻辑
        if (url.includes('/creation/') && currentPage !== 'creation') {
            document.body.dataset.ttHelperPage = 'creation';
            initCreatePage();
        }
        else if (url.includes('/manage/campaign') && isCampaignLevel && currentPage !== 'list') {
             document.body.dataset.ttHelperPage = 'list';
             initListPage();
             attachTableObserver();
        }
        else if (url.includes('/manage/campaign') && !isCampaignLevel && currentPage !== 'other-level') {
            document.body.dataset.ttHelperPage = 'other-level';
            console.log(`[TT助手] V3.2: 进入 ${currentLevel} 页面, 停止采集。`);
        }
        else if (!url.includes('/creation/') && !url.includes('/manage/campaign') && currentPage !== 'other') {
             document.body.dataset.ttHelperPage = 'other';
        }
    });

    urlObserver.observe(document.body, { childList: true, subtree: true });

    // 4. 初始执行
    const url = window.location.href;
    const currentUrlParams = new URLSearchParams(window.location.search);
    const currentLevel = currentUrlParams.get('level') || 'campaign';
    const isCampaignLevel = !currentLevel || currentLevel === 'campaign';

    if (url.includes('/creation/')) {
        document.body.dataset.ttHelperPage = 'creation';
        initCreatePage();
    } else if (url.includes('/manage/campaign') && isCampaignLevel) {
       document.body.dataset.ttHelperPage = 'list';
       initListPage();
       attachTableObserver();
    }

    // V3.0: 初始执行 BC On-Load 采集器
    initiateBcScrapeOnLoad();

})();
