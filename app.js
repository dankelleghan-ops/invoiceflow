// ============================================================
// InvoiceFlow — Professional Invoicing Application
// ============================================================

// --------------- State Management ---------------
let state = {
    invoices: [],
    estimates: [],
    clients: [],
    services: [],
    expenses: [],
    settings: {
        company: 'Kelleghan Productions Inc.',
        name: 'Daniel Kelleghan',
        email: 'dankelleghan@gmail.com',
        phone: '630-460-9618',
        address: '1822 S. Halsted St. Apt. 3\nChicago, IL 60608',
        taxRate: 0,
        paymentTerms: 30,
        invoicePrefix: 'INV-kelleghan-productions-inc-',
        estimatePrefix: 'EST-kelleghan-productions-inc-',
        currency: 'USD',
        memo: 'ACH Payment Details:\nBank: Chase\nBank Address: 270 Park Avenue, New York, NY 10017\nAccount Name: Kelleghan Productions Inc.\nRouting Number: 071000013\nAccount Number: 316751616\nRouting Type: ACH\nAccount Type: Checking\n\nZelle Payment:\ndanielkelleghan@gmail.com\n\nPayment Terms: Net 30 - Payment is due within 30 days of the invoice date.\n\nThank you for your business!'
    },
    currentEditId: null,
    currentFormMode: 'invoice', // 'invoice' or 'estimate'
    currentView: 'dashboard',
    reportPeriod: 'month'
};

const CURRENCY_SYMBOLS = { USD: '$', EUR: '€', GBP: '£', CAD: 'C$', AUD: 'A$' };

// --------------- GitHub Cloud Sync ---------------
let githubConfig = {
    token: null,
    repo: null,
    fileSha: null,
    connected: false,
    lastSync: null
};
let githubSaveTimer = null;
const GITHUB_API = 'https://api.github.com';
const GITHUB_DATA_FILE = 'invoiceflow-data.json';

function loadGitHubConfig() {
    try {
        const saved = localStorage.getItem('invoiceflow_github');
        if (saved) {
            const data = JSON.parse(saved);
            githubConfig.repo = data.repo || null;
            githubConfig.fileSha = data.fileSha || null;
            githubConfig.connected = data.connected || false;
            githubConfig.lastSync = data.lastSync || null;
        }
        githubConfig.token = localStorage.getItem('invoiceflow_github_token') || null;
    } catch (e) {
        console.error('Failed to load GitHub config:', e);
    }
}

function saveGitHubConfig() {
    localStorage.setItem('invoiceflow_github', JSON.stringify({
        repo: githubConfig.repo,
        fileSha: githubConfig.fileSha,
        connected: githubConfig.connected,
        lastSync: githubConfig.lastSync
    }));
    if (githubConfig.token) {
        localStorage.setItem('invoiceflow_github_token', githubConfig.token);
    }
}

async function githubApiRequest(method, endpoint, body = null) {
    if (!githubConfig.token) throw new Error('No GitHub token configured');
    const token = githubConfig.token.trim();
    const opts = {
        method,
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28'
        }
    };
    if (body) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
    }
    console.log(`GitHub API: ${method} ${endpoint}`);
    const res = await fetch(`${GITHUB_API}${endpoint}`, opts);
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        console.error(`GitHub API ${res.status}:`, err);
        throw new Error(err.message || `GitHub API error: ${res.status}`);
    }
    return res.status === 204 ? null : res.json();
}

async function loadFromGitHub() {
    if (!githubConfig.connected || !githubConfig.repo || !githubConfig.token) return;
    updateSyncStatus('syncing');
    try {
        const data = await githubApiRequest('GET', `/repos/${githubConfig.repo}/contents/${GITHUB_DATA_FILE}`);
        githubConfig.fileSha = data.sha;
        const decoded = decodeURIComponent(escape(atob(data.content.replace(/\n/g, ''))));
        const parsed = JSON.parse(decoded);
        // Merge into state
        if (parsed.invoices) state.invoices = parsed.invoices;
        if (parsed.estimates) state.estimates = parsed.estimates;
        if (parsed.clients) state.clients = parsed.clients;
        if (parsed.services) state.services = parsed.services;
        if (parsed.expenses) state.expenses = parsed.expenses;
        if (parsed.settings) state.settings = { ...state.settings, ...parsed.settings };
        // Migrate old address formats
        migrateAddresses();
        // Update localStorage cache
        localStorage.setItem('invoiceflow_data', JSON.stringify({
            invoices: state.invoices, estimates: state.estimates,
            clients: state.clients, services: state.services,
            expenses: state.expenses, settings: state.settings
        }));
        githubConfig.lastSync = new Date().toISOString();
        saveGitHubConfig();
        // Re-render everything
        populateSettingsForm();
        renderServicesList();
        updateDashboard();
        renderInvoicesList();
        renderEstimatesList();
        renderClients();
        updateSyncStatus('synced');
    } catch (e) {
        if (e.message && e.message.includes('Not Found')) {
            // File doesn't exist yet — will be created on first save
            updateSyncStatus('synced');
        } else {
            console.error('GitHub load failed:', e);
            updateSyncStatus('error');
            throw e;
        }
    }
}

async function saveToGitHub() {
    if (!githubConfig.connected || !githubConfig.repo || !githubConfig.token) return;
    updateSyncStatus('syncing');
    try {
        const content = JSON.stringify({
            invoices: state.invoices, estimates: state.estimates,
            clients: state.clients, services: state.services,
            expenses: state.expenses, settings: state.settings
        }, null, 2);
        const encoded = btoa(unescape(encodeURIComponent(content)));
        const body = {
            message: `Auto-save from InvoiceFlow — ${new Date().toLocaleString()}`,
            content: encoded
        };
        if (githubConfig.fileSha) {
            body.sha = githubConfig.fileSha;
        }
        const res = await githubApiRequest('PUT', `/repos/${githubConfig.repo}/contents/${GITHUB_DATA_FILE}`, body);
        githubConfig.fileSha = res.content.sha;
        githubConfig.lastSync = new Date().toISOString();
        saveGitHubConfig();
        updateSyncStatus('synced');
        updateLastSyncDisplay();
    } catch (e) {
        console.error('GitHub save failed:', e);
        updateSyncStatus('error');
        // If SHA mismatch (409 conflict), re-fetch the file to get current SHA
        if (e.message && (e.message.includes('409') || e.message.includes('does not match'))) {
            try {
                const data = await githubApiRequest('GET', `/repos/${githubConfig.repo}/contents/${GITHUB_DATA_FILE}`);
                githubConfig.fileSha = data.sha;
                saveGitHubConfig();
                // Retry save
                await saveToGitHub();
            } catch (retryErr) {
                console.error('GitHub retry failed:', retryErr);
            }
        }
    }
}

async function connectGitHub() {
    const repo = document.getElementById('github-repo').value.trim();
    const token = document.getElementById('github-token').value.trim();
    if (!repo || !token) {
        showToast('Please enter both repository and token', 'warning');
        return;
    }
    if (!repo.includes('/')) {
        showToast('Repository should be in format: username/repo-name', 'warning');
        return;
    }
    githubConfig.repo = repo;
    githubConfig.token = token;
    updateSyncStatus('syncing');
    try {
        // Step 1: Verify the token is valid by checking authenticated user
        let authUser;
        try {
            authUser = await githubApiRequest('GET', '/user');
            console.log('Authenticated as:', authUser.login);
        } catch (e) {
            throw new Error('Invalid token. Please check your Personal Access Token is correct and not expired.');
        }
        // Step 2: Verify the repo owner matches the authenticated user
        const repoOwner = repo.split('/')[0];
        if (authUser.login.toLowerCase() !== repoOwner.toLowerCase()) {
            console.warn(`Token user "${authUser.login}" vs repo owner "${repoOwner}"`);
        }
        // Step 3: Test repo access
        let repoExists = true;
        try {
            await githubApiRequest('GET', `/repos/${repo}`);
        } catch (e) {
            if (e.message && e.message.includes('Not Found')) {
                repoExists = false;
            } else if (e.message && (e.message.includes('Bad credentials') || e.message.includes('401'))) {
                throw new Error('Token authentication failed. Please generate a new token.');
            } else {
                throw e;
            }
        }
        // Auto-create the repo if it doesn't exist
        if (!repoExists) {
            const repoName = repo.split('/')[1];
            showToast('Repository not found — creating it...', 'info');
            try {
                await githubApiRequest('POST', '/user/repos', {
                    name: repoName,
                    private: true,
                    description: 'InvoiceFlow cloud data backup',
                    auto_init: false
                });
                // Brief wait for GitHub to provision the repo
                await new Promise(resolve => setTimeout(resolve, 1500));
            } catch (createErr) {
                throw new Error('Your token can see repos but not this one. When generating your token, make sure "' + repo + '" is selected under Repository Access, with Contents permission set to Read & Write.');
            }
        }
        // Try to read existing data file
        try {
            const fileData = await githubApiRequest('GET', `/repos/${repo}/contents/${GITHUB_DATA_FILE}`);
            githubConfig.fileSha = fileData.sha;
        } catch (e) {
            // File doesn't exist — do initial upload
            githubConfig.fileSha = null;
        }
        githubConfig.connected = true;
        githubConfig.lastSync = new Date().toISOString();
        saveGitHubConfig();
        // If no file exists yet, push current data up
        if (!githubConfig.fileSha) {
            await saveToGitHub();
            showToast('Connected! Your data has been synced to GitHub.', 'success');
        } else {
            // File exists — load from GitHub
            await loadFromGitHub();
            showToast('Connected! Data loaded from GitHub.', 'success');
        }
        updateGitHubSettingsUI();
    } catch (e) {
        githubConfig.connected = false;
        saveGitHubConfig();
        updateSyncStatus('error');
        updateGitHubSettingsUI();
        showToast('Connection failed: ' + e.message, 'error');
    }
}

function disconnectGitHub() {
    if (!confirm('Disconnect from GitHub? Your local data will be kept, but changes won\'t sync to the cloud.')) return;
    githubConfig.token = null;
    githubConfig.repo = null;
    githubConfig.fileSha = null;
    githubConfig.connected = false;
    githubConfig.lastSync = null;
    localStorage.removeItem('invoiceflow_github');
    localStorage.removeItem('invoiceflow_github_token');
    updateSyncStatus('disconnected');
    updateGitHubSettingsUI();
    showToast('Disconnected from GitHub', 'info');
}

async function syncFromGitHub() {
    if (!githubConfig.connected) return;
    try {
        await loadFromGitHub();
        showToast('Data synced from GitHub', 'success');
    } catch (e) {
        showToast('Sync failed: ' + e.message, 'error');
    }
}

function updateSyncStatus(status) {
    const icons = {
        disconnected: 'sync-icon-disconnected',
        synced: 'sync-icon-synced',
        syncing: 'sync-icon-syncing',
        error: 'sync-icon-error'
    };
    const labels = {
        disconnected: 'Not synced',
        synced: 'Synced',
        syncing: 'Syncing...',
        error: 'Sync error'
    };
    // Sidebar icons
    Object.values(icons).forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.add('hidden');
    });
    const activeIcon = document.getElementById(icons[status]);
    if (activeIcon) activeIcon.classList.remove('hidden');
    const label = document.getElementById('sidebar-sync-label');
    if (label) label.textContent = labels[status] || 'Not synced';

    // Settings badge
    const badge = document.getElementById('github-status-badge');
    if (badge) {
        const badgeStyles = {
            disconnected: 'bg-gray-100 text-gray-500',
            synced: 'bg-emerald-100 text-emerald-700',
            syncing: 'bg-blue-100 text-blue-700',
            error: 'bg-red-100 text-red-700'
        };
        const dotStyles = {
            disconnected: 'bg-gray-400',
            synced: 'bg-emerald-500',
            syncing: 'bg-blue-500',
            error: 'bg-red-500'
        };
        badge.className = `flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium ${badgeStyles[status] || badgeStyles.disconnected}`;
        const dot = badge.querySelector('span');
        if (dot) dot.className = `w-2 h-2 rounded-full ${dotStyles[status] || dotStyles.disconnected}`;
        badge.lastChild.textContent = labels[status] ? ` ${labels[status]}` : ' Not connected';
    }
}

function updateGitHubSettingsUI() {
    const connectBtn = document.getElementById('github-connect-btn');
    const syncBtn = document.getElementById('github-sync-btn');
    const disconnectBtn = document.getElementById('github-disconnect-btn');
    const repoInput = document.getElementById('github-repo');
    const tokenInput = document.getElementById('github-token');

    if (githubConfig.connected) {
        if (connectBtn) connectBtn.classList.add('hidden');
        if (syncBtn) syncBtn.classList.remove('hidden');
        if (disconnectBtn) disconnectBtn.classList.remove('hidden');
        if (repoInput) { repoInput.value = githubConfig.repo || ''; repoInput.disabled = true; repoInput.classList.add('bg-gray-50'); }
        if (tokenInput) { tokenInput.value = '••••••••••••••••'; tokenInput.disabled = true; tokenInput.classList.add('bg-gray-50'); }
    } else {
        if (connectBtn) connectBtn.classList.remove('hidden');
        if (syncBtn) syncBtn.classList.add('hidden');
        if (disconnectBtn) disconnectBtn.classList.add('hidden');
        if (repoInput) { repoInput.disabled = false; repoInput.classList.remove('bg-gray-50'); }
        if (tokenInput) { tokenInput.value = ''; tokenInput.disabled = false; tokenInput.classList.remove('bg-gray-50'); }
    }
    updateLastSyncDisplay();
}

function updateLastSyncDisplay() {
    const el = document.getElementById('github-last-sync');
    if (!el) return;
    if (githubConfig.lastSync) {
        el.classList.remove('hidden');
        const ago = getTimeAgo(githubConfig.lastSync);
        el.textContent = `Last synced ${ago}`;
    } else {
        el.classList.add('hidden');
    }
}

function getTimeAgo(isoDate) {
    const diff = Date.now() - new Date(isoDate).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

function toggleTokenVisibility() {
    const input = document.getElementById('github-token');
    const icon = document.getElementById('token-eye-icon');
    if (input.type === 'password') {
        input.type = 'text';
    } else {
        input.type = 'password';
    }
}

// --------------- Initialization ---------------
document.addEventListener('DOMContentLoaded', () => {
    loadFromStorage();
    loadGitHubConfig();
    initDarkMode();
    checkRecurringInvoices();
    populateSettingsForm();
    renderServicesList();
    initCreateForm('invoice');
    updateDashboard();
    renderInvoicesList();
    renderEstimatesList();
    renderClients();
    // Initialize GitHub sync UI and background sync
    if (githubConfig.connected) {
        updateSyncStatus('synced');
        updateGitHubSettingsUI();
        // Background sync from GitHub on load
        loadFromGitHub().catch(() => {});
    } else {
        updateSyncStatus('disconnected');
        updateGitHubSettingsUI();
    }
});

function loadFromStorage() {
    try {
        const saved = localStorage.getItem('invoiceflow_data');
        if (saved) {
            const data = JSON.parse(saved);
            state.invoices = data.invoices || [];
            state.estimates = data.estimates || [];
            state.clients = data.clients || [];
            state.services = data.services || [];
            state.expenses = data.expenses || [];
            if (data.settings) {
                const defaultMemo = state.settings.memo; // preserve new default
                state.settings = { ...state.settings, ...data.settings };
                // If saved memo was empty, use the new default ACH memo
                if (!state.settings.memo && defaultMemo) {
                    state.settings.memo = defaultMemo;
                }
                // One-time migration: convert single-line address to multi-line
                if (state.settings.address && !state.settings.address.includes('\n')) {
                    const match = state.settings.address.match(/^(.+),\s*([^,]+,\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?)$/);
                    if (match) {
                        state.settings.address = match[1].trim() + '\n' + match[2].trim();
                    }
                }
            }
        }
        // Migrate old single-string addresses to structured fields
        migrateAddresses();
    } catch (e) {
        console.error('Failed to load data:', e);
    }
    storageLoaded = true;
}

function parseAddressString(addr) {
    if (!addr) return {};
    const lines = addr.split('\n').map(l => l.trim()).filter(Boolean);
    const result = { address1: '', address2: '', city: '', state: '', zip: '', country: 'US' };
    if (lines.length >= 1) result.address1 = lines[0];
    if (lines.length >= 2) {
        // Try to parse "City, ST ZIP" from last line
        const cityStateZip = lines[lines.length - 1].match(/^(.+?),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/);
        if (cityStateZip) {
            result.city = cityStateZip[1].trim();
            result.state = cityStateZip[2];
            result.zip = cityStateZip[3];
            if (lines.length >= 3) result.address2 = lines.slice(1, -1).join(', ');
        } else {
            // Can't parse — put remainder into address2
            result.address2 = lines.slice(1).join(', ');
        }
    }
    return result;
}

function migrateAddresses() {
    // Migrate clients with old `address` field
    state.clients.forEach(c => {
        if (c.address && !c.address1) {
            const parsed = parseAddressString(c.address);
            c.address1 = parsed.address1;
            c.address2 = parsed.address2;
            c.city = parsed.city;
            c.state = parsed.state;
            c.zip = parsed.zip;
            c.country = parsed.country;
            delete c.address;
        }
    });
    // Migrate invoices with old `toAddress` field
    state.invoices.forEach(inv => {
        if (inv.toAddress && !inv.toAddress1) {
            const parsed = parseAddressString(inv.toAddress);
            inv.toAddress1 = parsed.address1;
            inv.toAddress2 = parsed.address2;
            inv.toCity = parsed.city;
            inv.toState = parsed.state;
            inv.toZip = parsed.zip;
            inv.toCountry = parsed.country;
            delete inv.toAddress;
        }
    });
    // Migrate estimates with old `toAddress` field
    state.estimates.forEach(est => {
        if (est.toAddress && !est.toAddress1) {
            const parsed = parseAddressString(est.toAddress);
            est.toAddress1 = parsed.address1;
            est.toAddress2 = parsed.address2;
            est.toCity = parsed.city;
            est.toState = parsed.state;
            est.toZip = parsed.zip;
            est.toCountry = parsed.country;
            delete est.toAddress;
        }
    });
}

let storageLoaded = false;

function saveToStorage() {
    try {
        // Don't save until initial data has been loaded
        if (!storageLoaded) {
            console.warn('saveToStorage blocked: storage not yet loaded');
            return;
        }
        // Instant local save
        localStorage.setItem('invoiceflow_data', JSON.stringify({
            invoices: state.invoices,
            estimates: state.estimates,
            clients: state.clients,
            services: state.services,
            expenses: state.expenses,
            settings: state.settings
        }));
        // Debounced GitHub sync (2 seconds)
        if (githubConfig.connected) {
            clearTimeout(githubSaveTimer);
            githubSaveTimer = setTimeout(() => saveToGitHub(), 2000);
        }
    } catch (e) {
        console.error('Failed to save data:', e);
        showToast('Failed to save data', 'error');
    }
}

// --------------- Unsaved Changes Check ---------------
function formHasContent() {
    if (state.currentView !== 'create') return false;
    const rows = document.querySelectorAll('#line-items .line-item-row');
    const hasLineItems = Array.from(rows).some(row => {
        const inputs = row.querySelectorAll('input');
        const descVal = inputs[0] ? inputs[0].value.trim() : '';
        const rateVal = inputs[2] ? inputs[2].value.trim() : '';
        return descVal !== '' || (rateVal !== '' && rateVal !== '0');
    });
    const hasClient = document.getElementById('to-company').value.trim() !== '' ||
                      document.getElementById('to-name').value.trim() !== '';
    return hasLineItems || hasClient;
}

let pendingNavigation = null;

function showUnsavedModal(targetView) {
    pendingNavigation = targetView;
    document.getElementById('unsaved-modal').classList.remove('hidden');
}

function closeUnsavedModal() {
    document.getElementById('unsaved-modal').classList.add('hidden');
    pendingNavigation = null;
}

document.addEventListener('DOMContentLoaded', function() {
    document.getElementById('unsaved-save-btn').addEventListener('click', function() {
        closeUnsavedModal();
        saveDocument('draft');
    });
    document.getElementById('unsaved-discard-btn').addEventListener('click', function() {
        const dest = pendingNavigation;
        closeUnsavedModal();
        state.currentEditId = null;
        showViewDirect(dest);
    });
    document.getElementById('unsaved-cancel-btn').addEventListener('click', function() {
        closeUnsavedModal();
    });
});

// --------------- Navigation ---------------
function showViewDirect(viewName) {
    state.currentView = viewName;

    // Hide all views
    document.querySelectorAll('[id^="view-"]').forEach(v => v.classList.add('hidden'));

    // Show target view
    const target = document.getElementById(`view-${viewName}`);
    if (target) {
        target.classList.remove('hidden');
        target.classList.remove('fade-in');
        void target.offsetWidth;
        target.classList.add('fade-in');
    }

    // Update sidebar active states
    document.querySelectorAll('.sidebar-link').forEach(link => {
        link.classList.remove('active');
        link.querySelector('svg').classList.remove('text-blue-300');
        link.querySelector('svg').classList.add('text-blue-300/60');
        link.classList.remove('text-white/90');
        link.classList.add('text-white/70');
    });

    const navBtn = document.getElementById(`nav-${viewName}`);
    if (navBtn) {
        navBtn.classList.add('active');
        navBtn.querySelector('svg').classList.remove('text-blue-300/60');
        navBtn.querySelector('svg').classList.add('text-blue-300');
        navBtn.classList.remove('text-white/70');
        navBtn.classList.add('text-white/90');
    }

    // Refresh data when switching views
    if (viewName === 'dashboard') updateDashboard();
    if (viewName === 'invoices') renderInvoicesList();
    if (viewName === 'estimates') renderEstimatesList();
    if (viewName === 'clients') renderClients();
    if (viewName === 'services') renderServicesLibrary();
    if (viewName === 'expenses') renderExpenses();
    if (viewName === 'reports') updateReports();
    if (viewName === 'create') {
        if (!state.currentEditId) initCreateForm(state.currentFormMode);
    }
}

function showView(viewName) {
    // Check for unsaved changes when leaving create view
    if (state.currentView === 'create' && viewName !== 'create' && formHasContent()) {
        showUnsavedModal(viewName);
        return;
    }
    showViewDirect(viewName);
}

// --------------- Toast Notifications ---------------
function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    const colors = {
        success: 'bg-emerald-500',
        error: 'bg-red-500',
        info: 'bg-brand-600',
        warning: 'bg-amber-500'
    };
    const icons = {
        success: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/>',
        error: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>',
        info: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>',
        warning: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>'
    };

    const toast = document.createElement('div');
    toast.className = `toast ${colors[type]} text-white px-5 py-3 rounded-lg shadow-lg flex items-center gap-3 text-sm font-medium`;
    toast.innerHTML = `<svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">${icons[type]}</svg>${message}`;
    container.appendChild(toast);

    setTimeout(() => {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 3000);
}

// --------------- Utility Functions ---------------
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2, 9);
}

function formatCurrency(amount) {
    const sym = CURRENCY_SYMBOLS[state.settings.currency] || '$';
    return sym + parseFloat(amount || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatDate(dateStr) {
    if (!dateStr) return '—';
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function getNextInvoiceNumber() {
    const prefix = state.settings.invoicePrefix || 'INV-kelleghan-productions-inc-';
    const nums = state.invoices.map(inv => {
        const match = (inv.invoiceNumber || '').match(/(\d+)$/);
        return match ? parseInt(match[1]) : 0;
    });
    const next = nums.length > 0 ? Math.max(...nums, 4999) + 1 : 5000;
    return prefix + String(next).padStart(4, '0');
}

function getNextEstimateNumber() {
    const prefix = state.settings.estimatePrefix || 'EST-kelleghan-productions-inc-';
    const nums = state.estimates.map(est => {
        const match = (est.invoiceNumber || '').match(/(\d+)$/);
        return match ? parseInt(match[1]) : 0;
    });
    const next = nums.length > 0 ? Math.max(...nums, 4999) + 1 : 5000;
    return prefix + String(next).padStart(4, '0');
}

function getTodayDate() {
    return new Date().toISOString().split('T')[0];
}

function getDueDate(daysFromNow) {
    const d = new Date();
    d.setDate(d.getDate() + (daysFromNow || 30));
    return d.toISOString().split('T')[0];
}

function getStatusBadge(status) {
    const styles = {
        draft: 'bg-gray-100 text-gray-600',
        sent: 'bg-blue-100 text-blue-700',
        paid: 'bg-emerald-100 text-emerald-700',
        overdue: 'bg-red-100 text-red-700',
        cancelled: 'bg-gray-100 text-gray-400',
        archived: 'bg-amber-100 text-amber-700'
    };
    return `<span class="status-badge ${styles[status] || styles.draft}">${status}</span>`;
}

// --------------- Dashboard ---------------
function updateDashboard() {
    const paid = state.invoices.filter(i => i.status === 'paid');
    const outstanding = state.invoices.filter(i => i.status === 'sent');
    const overdue = state.invoices.filter(i => i.status === 'overdue');

    const paidTotal = paid.reduce((s, i) => s + (i.total || 0), 0);
    const outstandingTotal = outstanding.reduce((s, i) => s + (i.total || 0), 0);
    const overdueTotal = overdue.reduce((s, i) => s + (i.total || 0), 0);

    document.getElementById('stat-revenue').textContent = formatCurrency(paidTotal);
    document.getElementById('stat-outstanding').textContent = formatCurrency(outstandingTotal);
    document.getElementById('stat-overdue').textContent = formatCurrency(overdueTotal);
    document.getElementById('stat-count').textContent = state.invoices.filter(i => i.status !== 'archived').length;

    document.getElementById('stat-revenue-sub').textContent = `${paid.length} paid invoice${paid.length !== 1 ? 's' : ''}`;
    document.getElementById('stat-outstanding-sub').textContent = `${outstanding.length} awaiting payment`;
    document.getElementById('stat-overdue-sub').textContent = `${overdue.length} past due`;
    document.getElementById('stat-count-sub').textContent = `All time`;

    // Estimates stats
    const pendingEstimates = state.estimates.filter(e => e.status === 'draft' || e.status === 'sent');
    const approvedEstimates = state.estimates.filter(e => e.status === 'approved');
    document.getElementById('stat-estimates').textContent = state.estimates.filter(e => e.status !== 'archived').length;
    document.getElementById('stat-estimates-sub').textContent = `${pendingEstimates.length} pending, ${approvedEstimates.length} approved`;

    // Check for newly overdue invoices
    checkOverdueInvoices();

    // Check backup reminder
    checkBackupReminder();

    // Recent invoices
    const container = document.getElementById('dashboard-invoices');
    const recent = [...state.invoices].filter(i => i.status !== 'archived').sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 5);

    if (recent.length === 0) {
        container.innerHTML = `
            <div class="px-6 py-12 text-center text-gray-400">
                <svg class="w-12 h-12 mx-auto mb-3 text-gray-200" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
                <p class="text-sm">No invoices yet. Create your first invoice to get started.</p>
            </div>`;
        return;
    }

    container.innerHTML = recent.map(inv => `
        <div class="flex items-center justify-between px-6 py-4 hover:bg-gray-50 cursor-pointer transition-colors" onclick="editInvoice('${inv.id}')">
            <div class="flex items-center gap-4">
                <div class="w-10 h-10 bg-brand-50 rounded-lg flex items-center justify-center">
                    <svg class="w-5 h-5 text-brand-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
                </div>
                <div>
                    <div class="text-sm font-semibold text-gray-900">${inv.invoiceNumber}</div>
                    <div class="text-xs text-gray-500">${inv.toCompany || 'Unknown Client'}</div>
                </div>
            </div>
            <div class="flex items-center gap-6">
                <div class="text-right">
                    <div class="text-sm font-semibold text-gray-900">${formatCurrency(inv.total)}</div>
                    <div class="text-xs text-gray-500">${formatDate(inv.date)}</div>
                </div>
                ${getStatusBadge(inv.status)}
            </div>
        </div>
    `).join('');
}

// --------------- Reports ---------------
function setReportPeriod(period) {
    state.reportPeriod = period;
    document.querySelectorAll('.report-period-btn').forEach(btn => {
        btn.classList.remove('bg-brand-50', 'text-brand-700');
        btn.classList.add('text-gray-500', 'hover:bg-gray-100');
    });
    const activeBtn = document.querySelector(`.report-period-btn[onclick="setReportPeriod('${period}')"]`);
    if (activeBtn) {
        activeBtn.classList.add('bg-brand-50', 'text-brand-700');
        activeBtn.classList.remove('text-gray-500', 'hover:bg-gray-100');
    }
    updateReports();
}

function getReportDateRange(period) {
    const now = new Date();
    let start, end;
    switch (period) {
        case 'week': {
            const day = now.getDay();
            start = new Date(now);
            start.setDate(now.getDate() - day);
            end = new Date(now);
            break;
        }
        case 'month':
            start = new Date(now.getFullYear(), now.getMonth(), 1);
            end = new Date(now);
            break;
        case 'quarter': {
            const qMonth = Math.floor(now.getMonth() / 3) * 3;
            start = new Date(now.getFullYear(), qMonth, 1);
            end = new Date(now);
            break;
        }
        case 'year':
            start = new Date(now.getFullYear(), 0, 1);
            end = new Date(now);
            break;
        case 'lastYear':
            start = new Date(now.getFullYear() - 1, 0, 1);
            end = new Date(now.getFullYear() - 1, 11, 31);
            break;
        case 'all':
        default:
            return { start: null, end: null };
    }
    return {
        start: start.toISOString().split('T')[0],
        end: end.toISOString().split('T')[0]
    };
}

function populateReportClientFilter() {
    const select = document.getElementById('report-client-filter');
    if (!select) return;
    const current = select.value;
    const clients = [...new Set(state.invoices.map(i => i.toCompany).filter(Boolean))].sort();
    select.innerHTML = '<option value="">All Clients</option>' +
        clients.map(c => `<option value="${c}" ${c === current ? 'selected' : ''}>${c}</option>`).join('');
}

function updateReports() {
    populateReportClientFilter();
    const { start, end } = getReportDateRange(state.reportPeriod);
    const clientFilter = (document.getElementById('report-client-filter') || {}).value || '';

    let filtered = state.invoices;
    if (start && end) {
        filtered = filtered.filter(inv => {
            const d = inv.date;
            return d && d >= start && d <= end;
        });
    }
    if (clientFilter) {
        filtered = filtered.filter(inv => inv.toCompany === clientFilter);
    }

    const paid = filtered.filter(i => i.status === 'paid');
    const outstanding = filtered.filter(i => i.status === 'sent' || i.status === 'overdue');

    const revenue = paid.reduce((s, i) => s + (i.total || 0), 0);
    const invoicedTotal = filtered.reduce((s, i) => s + (i.total || 0), 0);
    const outstandingTotal = outstanding.reduce((s, i) => s + (i.total || 0), 0);
    const avgInvoice = filtered.length > 0 ? invoicedTotal / filtered.length : 0;

    document.getElementById('report-revenue').textContent = formatCurrency(revenue);
    document.getElementById('report-revenue-count').textContent = `${paid.length} paid`;
    document.getElementById('report-invoiced').textContent = formatCurrency(invoicedTotal);
    document.getElementById('report-invoiced-count').textContent = `${filtered.length} invoice${filtered.length !== 1 ? 's' : ''}`;
    document.getElementById('report-outstanding').textContent = formatCurrency(outstandingTotal);
    document.getElementById('report-outstanding-count').textContent = `${outstanding.length} unpaid`;
    document.getElementById('report-average').textContent = formatCurrency(avgInvoice);
    document.getElementById('report-average-count').textContent = `${filtered.length} total`;

    // Expenses in period
    let filteredExpenses = state.expenses;
    if (start && end) {
        filteredExpenses = filteredExpenses.filter(exp => exp.date && exp.date >= start && exp.date <= end);
    }
    const expenseTotal = filteredExpenses.reduce((s, e) => s + (e.amount || 0), 0);
    const profit = revenue - expenseTotal;

    document.getElementById('report-expenses').textContent = formatCurrency(expenseTotal);
    document.getElementById('report-expenses-count').textContent = `${filteredExpenses.length} expense${filteredExpenses.length !== 1 ? 's' : ''}`;
    const profitEl = document.getElementById('report-profit');
    profitEl.textContent = formatCurrency(Math.abs(profit));
    if (profit < 0) {
        profitEl.textContent = '-' + profitEl.textContent;
        profitEl.className = 'text-2xl font-bold text-red-600';
    } else {
        profitEl.className = 'text-2xl font-bold text-emerald-600';
    }

    renderRevenueChart();

    const container = document.getElementById('report-invoices');
    if (filtered.length === 0) {
        container.innerHTML = '<div class="px-6 py-8 text-center text-gray-400 text-sm">No invoices in this period.</div>';
        return;
    }

    const sorted = [...filtered].sort((a, b) => new Date(b.date) - new Date(a.date));
    container.innerHTML = sorted.map(inv => `
        <div class="flex items-center justify-between px-6 py-3 hover:bg-gray-50 cursor-pointer transition-colors" onclick="editInvoice('${inv.id}')">
            <div class="flex items-center gap-3">
                <div>
                    <div class="text-sm font-medium text-gray-900">${inv.invoiceNumber}</div>
                    <div class="text-xs text-gray-500">${inv.toCompany || 'Unknown Client'}</div>
                </div>
            </div>
            <div class="flex items-center gap-4">
                <div class="text-sm text-gray-500">${formatDate(inv.date)}</div>
                <div class="text-sm font-semibold text-gray-900 w-24 text-right">${formatCurrency(inv.total)}</div>
                ${getStatusBadge(inv.status)}
            </div>
        </div>
    `).join('');
}

function renderRevenueChart() {
    const canvas = document.getElementById('revenue-chart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;

    // Size canvas
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = 200 * dpr;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = '200px';
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = 200;

    // Gather last 12 months of paid revenue
    const months = [];
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const key = d.toISOString().slice(0, 7); // YYYY-MM
        const label = d.toLocaleDateString('en-US', { month: 'short' });
        months.push({ key, label, total: 0 });
    }

    state.invoices.forEach(inv => {
        if (inv.status === 'paid' && inv.date) {
            const mKey = inv.date.slice(0, 7);
            const m = months.find(mm => mm.key === mKey);
            if (m) m.total += inv.total || 0;
        }
    });

    const maxVal = Math.max(...months.map(m => m.total), 1);
    const barW = (w - 80) / 12;
    const chartH = h - 40;
    const left = 50;

    // Clear
    ctx.clearRect(0, 0, w, h);

    // Grid lines
    ctx.strokeStyle = '#e5e7eb';
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
        const y = 10 + (chartH / 4) * i;
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(w - 10, y);
        ctx.stroke();

        // Y labels
        ctx.fillStyle = '#9ca3af';
        ctx.font = '10px Inter, sans-serif';
        ctx.textAlign = 'right';
        const val = maxVal - (maxVal / 4) * i;
        ctx.fillText(val >= 1000 ? '$' + (val / 1000).toFixed(1) + 'k' : '$' + Math.round(val), left - 8, y + 4);
    }

    // Bars
    months.forEach((m, i) => {
        const x = left + i * barW + barW * 0.15;
        const bw = barW * 0.7;
        const barH = (m.total / maxVal) * chartH;
        const y = 10 + chartH - barH;

        // Bar
        ctx.fillStyle = m.total > 0 ? '#2563eb' : '#e5e7eb';
        ctx.beginPath();
        ctx.roundRect(x, y, bw, barH, [4, 4, 0, 0]);
        ctx.fill();

        // X label
        ctx.fillStyle = '#6b7280';
        ctx.font = '10px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(m.label, x + bw / 2, h - 5);
    });
}

function checkOverdueInvoices() {
    const today = new Date().toISOString().split('T')[0];
    let changed = false;
    state.invoices.forEach(inv => {
        if (inv.status === 'archived') return;
        if (inv.status === 'sent' && inv.dueDate && inv.dueDate < today) {
            inv.status = 'overdue';
            changed = true;
        }
    });
    if (changed) saveToStorage();
}

// --------------- Invoice List ---------------
function renderInvoicesList() {
    const tbody = document.getElementById('invoices-table-body');
    const search = (document.getElementById('invoice-search')?.value || '').toLowerCase();
    const filter = document.getElementById('invoice-filter')?.value || 'all';

    let filtered = [...state.invoices].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    if (search) {
        filtered = filtered.filter(inv =>
            inv.invoiceNumber.toLowerCase().includes(search) ||
            (inv.toCompany || '').toLowerCase().includes(search) ||
            (inv.toName || '').toLowerCase().includes(search)
        );
    }

    if (filter === 'all') {
        filtered = filtered.filter(inv => inv.status !== 'archived');
    } else {
        filtered = filtered.filter(inv => inv.status === filter);
    }

    if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="px-6 py-12 text-center text-gray-400 text-sm">No invoices found.</td></tr>';
        clearBulkSelection();
        return;
    }

    tbody.innerHTML = filtered.map(inv => `
        <tr class="hover:bg-gray-50 transition-colors">
            <td class="px-3 py-4 w-10"><input type="checkbox" class="invoice-checkbox rounded border-gray-300" data-id="${inv.id}" onchange="toggleSelectInvoice('${inv.id}')" ${selectedInvoices.has(inv.id) ? 'checked' : ''}></td>
            <td class="px-6 py-4">
                <span class="text-sm font-semibold text-brand-600 cursor-pointer hover:text-brand-700" onclick="editInvoice('${inv.id}')">${inv.invoiceNumber}</span>
                ${inv.isRecurring ? '<svg class="w-3.5 h-3.5 text-brand-400 inline ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24" title="Recurring"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>' : ''}
            </td>
            <td class="px-6 py-4">
                <div class="text-sm font-medium text-gray-900">${inv.toCompany || '—'}</div>
                <div class="text-xs text-gray-500">${inv.toName || ''}</div>
            </td>
            <td class="px-6 py-4 text-sm text-gray-600">${formatDate(inv.date)}</td>
            <td class="px-6 py-4 text-sm font-semibold text-gray-900">${formatCurrency(inv.total)}</td>
            <td class="px-6 py-4">${getStatusBadge(inv.status)}</td>
            <td class="px-6 py-4 max-w-[200px]">${inv.notes ? `<span class="text-xs text-gray-500 italic line-clamp-2" title="${inv.notes.replace(/"/g, '&quot;')}">${inv.notes.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</span>` : '<span class="text-xs text-gray-300">—</span>'}</td>
            <td class="px-6 py-4">
                <div class="flex items-center justify-end gap-1">
                    <button onclick="editInvoice('${inv.id}')" title="Edit" class="p-2 text-gray-400 hover:text-brand-600 hover:bg-brand-50 rounded-lg transition-colors">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
                    </button>
                    <button onclick="duplicateInvoice('${inv.id}')" title="Duplicate" class="p-2 text-gray-400 hover:text-brand-600 hover:bg-brand-50 rounded-lg transition-colors">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
                    </button>
                    <button onclick="viewInvoicePDF('${inv.id}')" title="Preview" class="p-2 text-gray-400 hover:text-brand-600 hover:bg-brand-50 rounded-lg transition-colors">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
                    </button>
                    <button onclick="toggleInvoiceStatus('${inv.id}')" title="Toggle Status" class="p-2 text-gray-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg transition-colors">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
                    </button>
                    ${inv.status !== 'paid' && inv.status !== 'draft' && inv.status !== 'archived' ? `<button onclick="recordPayment('${inv.id}')" title="Record Payment" class="p-2 text-gray-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg transition-colors">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
                    </button>` : ''}
                    ${inv.status === 'overdue' ? `<button onclick="sendReminder('${inv.id}')" title="Send Reminder" class="p-2 text-gray-400 hover:text-orange-600 hover:bg-orange-50 rounded-lg transition-colors">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/></svg>
                    </button>` : ''}
                    <button onclick="archiveInvoice('${inv.id}')" title="Archive" class="p-2 text-gray-400 hover:text-amber-600 hover:bg-amber-50 rounded-lg transition-colors">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"/></svg>
                    </button>
                </div>
                ${inv.lastReminderDate ? `<div class="text-xs text-orange-500 text-right mt-1">Reminded ${formatDate(inv.lastReminderDate)}</div>` : ''}
            </td>
        </tr>
    `).join('');
}

function filterInvoices() {
    renderInvoicesList();
}

function toggleInvoiceStatus(id) {
    const inv = state.invoices.find(i => i.id === id);
    if (!inv) return;
    const cycle = { draft: 'sent', sent: 'paid', paid: 'draft', overdue: 'paid', cancelled: 'draft', archived: 'draft' };
    inv.status = cycle[inv.status] || 'draft';
    saveToStorage();
    renderInvoicesList();
    updateDashboard();
    showToast(`Invoice marked as ${inv.status}`);
}

function archiveInvoice(id) {
    if (!confirm('Archive this invoice? You can find it later under the Archived filter.')) return;
    const inv = state.invoices.find(i => i.id === id);
    if (!inv) return;
    inv.status = 'archived';
    inv.updatedAt = new Date().toISOString();
    saveToStorage();
    renderInvoicesList();
    updateDashboard();
    showToast('Invoice archived', 'info');
}

function duplicateInvoice(id) {
    const inv = state.invoices.find(i => i.id === id);
    if (!inv) return;
    const dupe = {
        ...JSON.parse(JSON.stringify(inv)),
        id: generateId(),
        invoiceNumber: getNextInvoiceNumber(),
        status: 'draft',
        date: getTodayDate(),
        dueDate: getDueDate(state.settings.paymentTerms),
        createdAt: new Date().toISOString()
    };
    state.invoices.push(dupe);
    saveToStorage();
    renderInvoicesList();
    showToast('Invoice duplicated');
}

function viewInvoicePDF(id) {
    const inv = state.invoices.find(i => i.id === id);
    if (!inv) return;
    loadInvoiceToForm(inv);
    previewInvoice();
}

// --------------- Create / Edit Form (Invoice or Estimate) ---------------
function initCreateForm(mode) {
    mode = mode || 'invoice';
    state.currentFormMode = mode;
    state.currentEditId = null;

    const isEstimate = mode === 'estimate';
    document.getElementById('create-title').textContent = isEstimate ? 'Create Estimate' : 'Create Invoice';
    document.getElementById('create-subtitle').textContent = isEstimate
        ? 'Fill in the details below to generate a professional estimate.'
        : 'Fill in the details below to generate a professional invoice.';
    document.getElementById('create-send-btn').textContent = isEstimate ? 'Save & Send Estimate' : 'Save & Send';

    // Render read-only business info from settings
    renderFromBusinessInfo();

    // Client dropdown + clear fields
    populateClientDropdown();
    document.getElementById('to-company').value = '';
    document.getElementById('to-name').value = '';
    document.getElementById('to-email').value = '';
    document.getElementById('to-phone').value = '';
    document.getElementById('to-address1').value = '';
    document.getElementById('to-address2').value = '';
    document.getElementById('to-city').value = '';
    document.getElementById('to-state').value = '';
    document.getElementById('to-zip').value = '';
    document.getElementById('to-country').value = 'US';

    // Document number
    document.getElementById('invoice-number').value = isEstimate ? getNextEstimateNumber() : getNextInvoiceNumber();
    document.getElementById('invoice-date').value = getTodayDate();
    document.getElementById('invoice-due-date').value = isEstimate ? '' : getDueDate(state.settings.paymentTerms);
    document.getElementById('due-date-wrapper').style.display = isEstimate ? 'none' : '';
    document.getElementById('tax-rate').value = state.settings.taxRate ?? 0;

    // Memo — only pre-fill payment info for invoices
    document.getElementById('invoice-memo').value = isEstimate ? '' : (state.settings.memo || '');
    document.getElementById('invoice-notes').value = '';

    // Invoice-level discount (available on both invoices and estimates)
    document.getElementById('invoice-discount').value = '';
    document.getElementById('invoice-discount-type').value = 'percent';

    // Deposit - only for invoices
    document.getElementById('deposit-wrapper').style.display = isEstimate ? 'none' : '';
    document.getElementById('deposit-amount').value = '';
    document.getElementById('deposit-date').value = '';

    // Recurring - only for invoices
    document.getElementById('recurring-wrapper').style.display = isEstimate ? 'none' : '';
    document.getElementById('recurring-enabled').checked = false;
    document.getElementById('recurring-fields').classList.add('hidden');
    document.getElementById('recurring-end-date').value = '';

    // Line items - start with one empty row
    document.getElementById('line-items').innerHTML = '';
    addLineItem();

    recalculate();
}

function addLineItem(desc = '', qty = 1, rate = '', serviceId = '', discountValue = '', discountType = 'percent') {
    const tbody = document.getElementById('line-items');
    const row = document.createElement('tr');
    row.className = 'line-item-row border-b border-gray-100';

    // Build service options
    const serviceOptions = state.services.map(s =>
        `<option value="${s.id}" ${s.id === serviceId ? 'selected' : ''}>${s.name}</option>`
    ).join('');

    row.innerHTML = `
        <td class="py-2 pr-2">
            <select class="line-service w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:border-brand-500 bg-white" onchange="onLineServiceSelect(this)">
                <option value="">Custom</option>
                ${serviceOptions}
                <option value="__new__">+ New Service</option>
            </select>
        </td>
        <td class="py-2 px-2">
            <input type="text" placeholder="Description of service or product" value="${desc}" class="line-desc w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:border-brand-500">
        </td>
        <td class="py-2 px-2">
            <input type="number" placeholder="0" value="${qty}" min="0" step="1" class="line-qty w-full px-3 py-2 border border-gray-200 rounded-lg text-sm text-center focus:border-brand-500" oninput="recalculate()">
        </td>
        <td class="py-2 px-2">
            <input type="number" placeholder="0.00" value="${rate}" min="0" step="0.01" class="line-rate w-full px-3 py-2 border border-gray-200 rounded-lg text-sm text-center focus:border-brand-500" oninput="recalculate()">
        </td>
        <td class="py-2 px-2">
            <div class="flex items-center gap-1">
                <input type="number" placeholder="0" value="${discountValue}" min="0" step="0.01" class="line-discount w-full px-2 py-2 border border-gray-200 rounded-lg text-sm text-center focus:border-brand-500" oninput="recalculate()">
                <select class="line-discount-type px-1 py-2 border border-gray-200 rounded-lg text-xs focus:border-brand-500 bg-white" onchange="recalculate()">
                    <option value="percent" ${discountType === 'percent' ? 'selected' : ''}>%</option>
                    <option value="flat" ${discountType === 'flat' ? 'selected' : ''}>$</option>
                </select>
            </div>
        </td>
        <td class="py-2 px-2 text-right">
            <span class="line-amount text-sm font-medium text-gray-900">$0.00</span>
        </td>
        <td class="py-2 pl-2 text-center">
            <button onclick="removeLineItem(this)" class="p-1 text-gray-300 hover:text-red-500 transition-colors">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
            </button>
        </td>
    `;
    tbody.appendChild(row);
    recalculate();
}

function onLineServiceSelect(select) {
    const row = select.closest('tr');
    const serviceId = select.value;
    if (serviceId === '__new__') {
        select.value = '';
        showInlineServiceForm(row);
        return;
    }
    if (!serviceId) {
        // "Custom" selected — clear fields for manual entry
        row.querySelector('.line-desc').value = '';
        row.querySelector('.line-rate').value = '';
        recalculate();
        return;
    }
    const service = state.services.find(s => s.id === serviceId);
    if (service) {
        row.querySelector('.line-desc').value = service.description || service.name;
        row.querySelector('.line-rate').value = service.rate || '';
        recalculate();
    }
}

function showInlineServiceForm(row) {
    // Remove any existing inline service form
    const existing = document.getElementById('inline-service-form');
    if (existing) existing.remove();

    const formRow = document.createElement('tr');
    formRow.id = 'inline-service-form';
    formRow.className = 'bg-brand-50 border-b border-brand-200';
    formRow.innerHTML = `
        <td colspan="7" class="p-4">
            <div class="flex items-end gap-3">
                <div class="flex-1">
                    <label class="block text-xs font-medium text-gray-600 mb-1">Service Name</label>
                    <input type="text" id="inline-svc-name" placeholder="e.g. Video Editing" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:border-brand-500">
                </div>
                <div class="flex-1">
                    <label class="block text-xs font-medium text-gray-600 mb-1">Description</label>
                    <input type="text" id="inline-svc-desc" placeholder="Brief description" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:border-brand-500">
                </div>
                <div class="w-28">
                    <label class="block text-xs font-medium text-gray-600 mb-1">Rate ($)</label>
                    <input type="number" id="inline-svc-rate" placeholder="0.00" min="0" step="0.01" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:border-brand-500">
                </div>
                <button onclick="saveInlineService()" class="px-4 py-2 bg-brand-600 text-white rounded-lg text-sm font-semibold hover:bg-brand-700 transition-colors whitespace-nowrap">Add Service</button>
                <button onclick="cancelInlineService()" class="px-3 py-2 text-gray-400 hover:text-gray-600 text-sm transition-colors">Cancel</button>
            </div>
        </td>
    `;
    row.after(formRow);
    document.getElementById('inline-svc-name').focus();
    // Store reference to the row that triggered this
    formRow.dataset.targetRowIndex = Array.from(row.parentElement.children).indexOf(row);
}

function saveInlineService() {
    const name = document.getElementById('inline-svc-name').value.trim();
    const desc = document.getElementById('inline-svc-desc').value.trim();
    const rate = parseFloat(document.getElementById('inline-svc-rate').value) || 0;

    if (!name) {
        showToast('Service name is required', 'warning');
        return;
    }

    const newService = {
        id: generateId(),
        name: name,
        description: desc,
        rate: rate,
        createdAt: new Date().toISOString()
    };
    state.services.push(newService);
    saveToStorage();

    // Get the target row and update it
    const formRow = document.getElementById('inline-service-form');
    const targetIndex = parseInt(formRow.dataset.targetRowIndex);
    const rows = document.querySelectorAll('#line-items .line-item-row');
    const targetRow = rows[targetIndex];

    // Remove the inline form
    formRow.remove();

    if (targetRow) {
        // Rebuild the service dropdown in the target row with the new service selected
        const serviceOptions = state.services.map(s =>
            `<option value="${s.id}" ${s.id === newService.id ? 'selected' : ''}>${s.name}</option>`
        ).join('');
        targetRow.querySelector('.line-service').innerHTML = `<option value="">Custom</option>${serviceOptions}<option value="__new__">+ New Service</option>`;

        // Fill in description and rate
        targetRow.querySelector('.line-desc').value = desc || name;
        targetRow.querySelector('.line-rate').value = rate || '';
        recalculate();
    }

    // Also update all other row dropdowns to include the new service
    rows.forEach((row, i) => {
        if (i === targetIndex) return;
        const select = row.querySelector('.line-service');
        const currentVal = select.value;
        const opts = state.services.map(s =>
            `<option value="${s.id}" ${s.id === currentVal ? 'selected' : ''}>${s.name}</option>`
        ).join('');
        select.innerHTML = `<option value="">Custom</option>${opts}<option value="__new__">+ New Service</option>`;
    });

    showToast(`Service "${name}" added`);
}

function cancelInlineService() {
    const formRow = document.getElementById('inline-service-form');
    if (formRow) formRow.remove();
}

function removeLineItem(btn) {
    const rows = document.querySelectorAll('.line-item-row');
    if (rows.length <= 1) {
        showToast('At least one line item is required', 'warning');
        return;
    }
    btn.closest('tr').remove();
    recalculate();
}

function recalculate() {
    let subtotal = 0;
    const taxRate = parseFloat(document.getElementById('tax-rate').value) || 0;

    document.querySelectorAll('.line-item-row').forEach(row => {
        const qty = parseFloat(row.querySelector('.line-qty').value) || 0;
        const rate = parseFloat(row.querySelector('.line-rate').value) || 0;
        const discountVal = parseFloat(row.querySelector('.line-discount')?.value) || 0;
        const discountType = row.querySelector('.line-discount-type')?.value || 'percent';
        let lineTotal = qty * rate;
        if (discountVal > 0) {
            if (discountType === 'percent') {
                lineTotal -= lineTotal * (discountVal / 100);
            } else {
                lineTotal -= discountVal;
            }
        }
        if (lineTotal < 0) lineTotal = 0;
        row.querySelector('.line-amount').textContent = formatCurrency(lineTotal);
        subtotal += lineTotal;
    });

    // Invoice-level discount
    const invDiscountVal = parseFloat(document.getElementById('invoice-discount').value) || 0;
    const invDiscountType = document.getElementById('invoice-discount-type').value || 'percent';
    let discountAmount = 0;
    if (invDiscountVal > 0) {
        if (invDiscountType === 'percent') {
            discountAmount = subtotal * (invDiscountVal / 100);
        } else {
            discountAmount = invDiscountVal;
        }
        if (discountAmount > subtotal) discountAmount = subtotal;
    }

    const taxableAmount = subtotal - discountAmount;
    const tax = taxableAmount * (taxRate / 100);
    const total = taxableAmount + tax;

    document.getElementById('subtotal').textContent = formatCurrency(subtotal);
    document.getElementById('discount-display').textContent = discountAmount > 0 ? `-${formatCurrency(discountAmount)}` : '';
    document.getElementById('tax-rate-display').textContent = taxRate;
    document.getElementById('tax-amount').textContent = formatCurrency(tax);
    document.getElementById('total').textContent = formatCurrency(total);
}

function getFormData() {
    const lineItems = [];
    document.querySelectorAll('.line-item-row').forEach(row => {
        const serviceSelect = row.querySelector('.line-service');
        const serviceId = serviceSelect ? serviceSelect.value : '';
        const serviceName = serviceSelect && serviceSelect.selectedIndex > 0 ? serviceSelect.options[serviceSelect.selectedIndex].text : '';
        const desc = row.querySelector('.line-desc').value.trim();
        const qty = parseFloat(row.querySelector('.line-qty').value) || 0;
        const rate = parseFloat(row.querySelector('.line-rate').value) || 0;
        const discountValue = parseFloat(row.querySelector('.line-discount')?.value) || 0;
        const discountType = row.querySelector('.line-discount-type')?.value || 'percent';
        let amount = qty * rate;
        if (discountValue > 0) {
            if (discountType === 'percent') {
                amount -= amount * (discountValue / 100);
            } else {
                amount -= discountValue;
            }
        }
        if (amount < 0) amount = 0;
        if (desc || qty || rate || serviceId) {
            lineItems.push({ serviceId, serviceName, description: desc, quantity: qty, rate: rate, discountValue, discountType, amount });
        }
    });

    const taxRate = parseFloat(document.getElementById('tax-rate').value) || 0;
    const subtotal = lineItems.reduce((s, li) => s + li.amount, 0);

    // Invoice-level discount
    const invDiscountValue = parseFloat(document.getElementById('invoice-discount').value) || 0;
    const invDiscountType = document.getElementById('invoice-discount-type').value || 'percent';
    let invDiscountAmount = 0;
    if (invDiscountValue > 0) {
        if (invDiscountType === 'percent') {
            invDiscountAmount = subtotal * (invDiscountValue / 100);
        } else {
            invDiscountAmount = invDiscountValue;
        }
        if (invDiscountAmount > subtotal) invDiscountAmount = subtotal;
    }

    const taxableAmount = subtotal - invDiscountAmount;
    const tax = taxableAmount * (taxRate / 100);
    const total = taxableAmount + tax;

    return {
        fromCompany: state.settings.company || '',
        fromName: state.settings.name || '',
        fromEmail: state.settings.email || '',
        fromPhone: state.settings.phone || '',
        fromAddress: state.settings.address || '',
        toCompany: document.getElementById('to-company').value.trim(),
        toName: document.getElementById('to-name').value.trim(),
        toEmail: document.getElementById('to-email').value.trim(),
        toPhone: document.getElementById('to-phone').value.trim(),
        toAddress1: document.getElementById('to-address1').value.trim(),
        toAddress2: document.getElementById('to-address2').value.trim(),
        toCity: document.getElementById('to-city').value.trim(),
        toState: document.getElementById('to-state').value.trim(),
        toZip: document.getElementById('to-zip').value.trim(),
        toCountry: document.getElementById('to-country').value.trim(),
        invoiceNumber: document.getElementById('invoice-number').value.trim(),
        date: document.getElementById('invoice-date').value,
        dueDate: document.getElementById('invoice-due-date').value,
        taxRate,
        discountValue: invDiscountValue,
        discountType: invDiscountType,
        discountAmount: invDiscountAmount,
        lineItems,
        subtotal,
        tax,
        total,
        memo: document.getElementById('invoice-memo').value.trim(),
        notes: document.getElementById('invoice-notes').value.trim(),
        depositAmount: parseFloat(document.getElementById('deposit-amount').value) || 0,
        depositDate: document.getElementById('deposit-date').value
    };
}

function loadInvoiceToForm(inv) {
    state.currentEditId = inv.id;
    state.currentFormMode = 'invoice';
    document.getElementById('create-title').textContent = `Edit Invoice ${inv.invoiceNumber}`;
    document.getElementById('create-subtitle').textContent = 'Modify the details and save.';
    document.getElementById('create-send-btn').textContent = 'Save & Send';

    // Read-only business info from settings
    renderFromBusinessInfo();

    // Client dropdown — try to match existing client
    const matchedClient = state.clients.find(c => c.company && c.company.toLowerCase() === (inv.toCompany || '').toLowerCase());
    populateClientDropdown(matchedClient ? matchedClient.id : '');

    document.getElementById('to-company').value = inv.toCompany || '';
    document.getElementById('to-name').value = inv.toName || '';
    document.getElementById('to-email').value = inv.toEmail || '';
    document.getElementById('to-phone').value = inv.toPhone || '';
    document.getElementById('to-address1').value = inv.toAddress1 || '';
    document.getElementById('to-address2').value = inv.toAddress2 || '';
    document.getElementById('to-city').value = inv.toCity || '';
    document.getElementById('to-state').value = inv.toState || '';
    document.getElementById('to-zip').value = inv.toZip || '';
    document.getElementById('to-country').value = inv.toCountry || 'US';

    document.getElementById('invoice-number').value = inv.invoiceNumber || '';
    document.getElementById('invoice-date').value = inv.date || '';
    document.getElementById('invoice-due-date').value = inv.dueDate || '';
    document.getElementById('due-date-wrapper').style.display = '';
    document.getElementById('tax-rate').value = inv.taxRate ?? 0;
    document.getElementById('invoice-memo').value = inv.memo || '';
    document.getElementById('invoice-notes').value = inv.notes || '';

    // Invoice-level discount
    document.getElementById('invoice-discount').value = inv.discountValue || '';
    document.getElementById('invoice-discount-type').value = inv.discountType || 'percent';

    // Deposit fields
    document.getElementById('deposit-wrapper').style.display = '';
    document.getElementById('deposit-amount').value = inv.depositAmount || '';
    document.getElementById('deposit-date').value = inv.depositDate || '';

    // Recurring fields
    document.getElementById('recurring-wrapper').style.display = '';
    document.getElementById('recurring-enabled').checked = inv.isRecurring || false;
    document.getElementById('recurring-frequency').value = inv.recurringFrequency || 'monthly';
    document.getElementById('recurring-end-date').value = inv.recurringEndDate || '';
    document.getElementById('recurring-fields').classList.toggle('hidden', !inv.isRecurring);

    // Line items
    document.getElementById('line-items').innerHTML = '';
    if (inv.lineItems && inv.lineItems.length > 0) {
        inv.lineItems.forEach(li => addLineItem(li.description, li.quantity, li.rate, li.serviceId || '', li.discountValue || '', li.discountType || 'percent'));
    } else {
        addLineItem();
    }

    recalculate();
}

function editInvoice(id) {
    const inv = state.invoices.find(i => i.id === id);
    if (!inv) return;
    state.currentFormMode = 'invoice';
    loadInvoiceToForm(inv);
    showView('create');
}

function editEstimate(id) {
    const est = state.estimates.find(i => i.id === id);
    if (!est) return;
    state.currentFormMode = 'estimate';
    loadEstimateToForm(est);
    showView('create');
}

function loadEstimateToForm(est) {
    state.currentEditId = est.id;
    state.currentFormMode = 'estimate';
    document.getElementById('create-title').textContent = `Edit Estimate ${est.invoiceNumber}`;
    document.getElementById('create-subtitle').textContent = 'Modify the estimate details and save.';
    document.getElementById('create-send-btn').textContent = 'Save & Send Estimate';

    // Read-only business info from settings
    renderFromBusinessInfo();

    const matchedClient = state.clients.find(c => c.company && c.company.toLowerCase() === (est.toCompany || '').toLowerCase());
    populateClientDropdown(matchedClient ? matchedClient.id : '');

    document.getElementById('to-company').value = est.toCompany || '';
    document.getElementById('to-name').value = est.toName || '';
    document.getElementById('to-email').value = est.toEmail || '';
    document.getElementById('to-phone').value = est.toPhone || '';
    document.getElementById('to-address1').value = est.toAddress1 || '';
    document.getElementById('to-address2').value = est.toAddress2 || '';
    document.getElementById('to-city').value = est.toCity || '';
    document.getElementById('to-state').value = est.toState || '';
    document.getElementById('to-zip').value = est.toZip || '';
    document.getElementById('to-country').value = est.toCountry || 'US';

    document.getElementById('invoice-number').value = est.invoiceNumber || '';
    document.getElementById('invoice-date').value = est.date || '';
    document.getElementById('invoice-due-date').value = '';
    document.getElementById('due-date-wrapper').style.display = 'none';
    document.getElementById('tax-rate').value = est.taxRate ?? 0;
    document.getElementById('invoice-memo').value = est.memo || '';
    document.getElementById('invoice-notes').value = est.notes || '';

    // Invoice-level discount (available on estimates too)
    document.getElementById('invoice-discount').value = est.discountValue || '';
    document.getElementById('invoice-discount-type').value = est.discountType || 'percent';

    // Hide deposit and recurring for estimates
    document.getElementById('deposit-wrapper').style.display = 'none';
    document.getElementById('recurring-wrapper').style.display = 'none';
    document.getElementById('recurring-enabled').checked = false;
    document.getElementById('recurring-fields').classList.add('hidden');

    document.getElementById('line-items').innerHTML = '';
    if (est.lineItems && est.lineItems.length > 0) {
        est.lineItems.forEach(li => addLineItem(li.description, li.quantity, li.rate, li.serviceId || '', li.discountValue || '', li.discountType || 'percent'));
    } else {
        addLineItem();
    }

    recalculate();
}

function viewEstimatePDF(id) {
    const est = state.estimates.find(i => i.id === id);
    if (!est) return;
    state.currentFormMode = 'estimate';
    loadEstimateToForm(est);
    previewInvoice();
}

// Universal save — routes to invoice or estimate based on mode
function saveDocument(status = 'draft') {
    if (state.currentFormMode === 'estimate') {
        saveEstimate(status);
    } else {
        saveInvoice(status);
    }
}

function saveInvoice(status = 'draft') {
    const data = getFormData();

    if (!data.invoiceNumber) {
        showToast('Invoice number is required', 'warning');
        return;
    }

    if (data.lineItems.length === 0) {
        showToast('Add at least one line item', 'warning');
        return;
    }

    // Auto-save client if new
    autoSaveClient(data);

    // 'save' keeps existing status (or 'sent' for new)
    let effectiveStatus = status;
    if (status === 'save') {
        if (state.currentEditId) {
            const existing = state.invoices.find(i => i.id === state.currentEditId);
            effectiveStatus = existing ? existing.status : 'sent';
        } else {
            effectiveStatus = 'sent';
        }
    }

    const recurringData = getRecurringFormData();

    if (state.currentEditId) {
        const idx = state.invoices.findIndex(i => i.id === state.currentEditId);
        if (idx !== -1) {
            state.invoices[idx] = {
                ...state.invoices[idx],
                ...data,
                ...recurringData,
                status: effectiveStatus,
                updatedAt: new Date().toISOString()
            };
            if (recurringData.isRecurring && !state.invoices[idx].recurringNextDate) {
                state.invoices[idx].recurringNextDate = getNextRecurringDate(data.date, recurringData.recurringFrequency);
            }
        }
    } else {
        const newInv = {
            id: generateId(),
            ...data,
            ...recurringData,
            status: effectiveStatus,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        if (recurringData.isRecurring) {
            newInv.recurringNextDate = getNextRecurringDate(data.date, recurringData.recurringFrequency);
        }
        state.invoices.push(newInv);
    }

    saveToStorage();

    if (status === 'sent') {
        showToast('Invoice saved and marked as sent');
        openEmailModal();
        // Stay on create view — navigation happens after email modal closes
        return;
    } else if (status === 'save') {
        showToast('Invoice saved');
    } else {
        showToast('Invoice saved as draft');
    }

    state.currentEditId = null;
    showViewDirect('invoices');
}

function saveEstimate(status = 'draft') {
    const data = getFormData();

    if (!data.invoiceNumber) {
        showToast('Estimate number is required', 'warning');
        return;
    }

    if (data.lineItems.length === 0) {
        showToast('Add at least one line item', 'warning');
        return;
    }

    autoSaveClient(data);

    // 'save' keeps existing status (or 'sent' for new)
    let effectiveStatus = status;
    if (status === 'save') {
        if (state.currentEditId) {
            const existing = state.estimates.find(i => i.id === state.currentEditId);
            effectiveStatus = existing ? existing.status : 'sent';
        } else {
            effectiveStatus = 'sent';
        }
    }

    if (state.currentEditId) {
        const idx = state.estimates.findIndex(i => i.id === state.currentEditId);
        if (idx !== -1) {
            state.estimates[idx] = {
                ...state.estimates[idx],
                ...data,
                status: effectiveStatus,
                updatedAt: new Date().toISOString()
            };
        }
    } else {
        state.estimates.push({
            id: generateId(),
            ...data,
            status: effectiveStatus,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        });
    }

    saveToStorage();

    if (status === 'sent') {
        showToast('Estimate saved and sent');
        openEmailModal();
        return;
    } else if (status === 'save') {
        showToast('Estimate saved');
    } else {
        showToast('Estimate saved as draft');
    }

    state.currentEditId = null;
    showViewDirect('estimates');
}

function autoSaveClient(data) {
    if (data.toCompany && !state.clients.find(c => c.company.toLowerCase() === data.toCompany.toLowerCase())) {
        state.clients.push({
            id: generateId(),
            company: data.toCompany,
            name: data.toName,
            email: data.toEmail,
            phone: data.toPhone,
            address1: data.toAddress1,
            address2: data.toAddress2,
            city: data.toCity,
            state: data.toState,
            zip: data.toZip,
            country: data.toCountry,
            createdAt: new Date().toISOString()
        });
    }
}

// --------------- Client Dropdown ---------------
function populateClientDropdown(selectedClientId) {
    const select = document.getElementById('client-select');
    const sorted = [...state.clients].sort((a, b) => (a.company || '').localeCompare(b.company || ''));
    select.innerHTML = '<option value="">+ New Client</option>' + sorted.map(c =>
        `<option value="${c.id}">${c.company}${c.name ? ' — ' + c.name : ''}</option>`
    ).join('');
    if (selectedClientId) {
        select.value = selectedClientId;
    }
}

function onClientSelect() {
    const select = document.getElementById('client-select');
    const clientId = select.value;
    if (!clientId) {
        // New client — clear fields
        document.getElementById('to-company').value = '';
        document.getElementById('to-name').value = '';
        document.getElementById('to-email').value = '';
        document.getElementById('to-phone').value = '';
        document.getElementById('to-address1').value = '';
        document.getElementById('to-address2').value = '';
        document.getElementById('to-city').value = '';
        document.getElementById('to-state').value = '';
        document.getElementById('to-zip').value = '';
        document.getElementById('to-country').value = 'US';
        return;
    }
    const client = state.clients.find(c => c.id === clientId);
    if (!client) return;
    document.getElementById('to-company').value = client.company || '';
    document.getElementById('to-name').value = client.name || '';
    document.getElementById('to-email').value = client.email || '';
    document.getElementById('to-phone').value = client.phone || '';
    document.getElementById('to-address1').value = client.address1 || '';
    document.getElementById('to-address2').value = client.address2 || '';
    document.getElementById('to-city').value = client.city || '';
    document.getElementById('to-state').value = client.state || '';
    document.getElementById('to-zip').value = client.zip || '';
    document.getElementById('to-country').value = client.country || 'US';
}

// --------------- Estimates List ---------------
function renderEstimatesList() {
    const tbody = document.getElementById('estimates-table-body');
    if (!tbody) return;
    const search = (document.getElementById('estimate-search')?.value || '').toLowerCase();
    const filter = document.getElementById('estimate-filter')?.value || 'all';

    let filtered = [...state.estimates].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    if (search) {
        filtered = filtered.filter(est =>
            (est.invoiceNumber || '').toLowerCase().includes(search) ||
            (est.toCompany || '').toLowerCase().includes(search) ||
            (est.toName || '').toLowerCase().includes(search)
        );
    }

    if (filter === 'all') {
        filtered = filtered.filter(est => est.status !== 'archived');
    } else {
        filtered = filtered.filter(est => est.status === filter);
    }

    if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="px-6 py-12 text-center text-gray-400 text-sm">No estimates found.</td></tr>';
        return;
    }

    tbody.innerHTML = filtered.map(est => `
        <tr class="hover:bg-gray-50 transition-colors">
            <td class="px-6 py-4">
                <span class="text-sm font-semibold text-brand-600 cursor-pointer hover:text-brand-700" onclick="editEstimate('${est.id}')">${est.invoiceNumber}</span>
            </td>
            <td class="px-6 py-4">
                <div class="text-sm font-medium text-gray-900">${est.toCompany || '—'}</div>
                <div class="text-xs text-gray-500">${est.toName || ''}</div>
            </td>
            <td class="px-6 py-4 text-sm text-gray-600">${formatDate(est.date)}</td>
            <td class="px-6 py-4 text-sm font-semibold text-gray-900">${formatCurrency(est.total)}</td>
            <td class="px-6 py-4">${getEstimateStatusBadge(est.status)}</td>
            <td class="px-6 py-4 max-w-[200px]">${est.notes ? `<span class="text-xs text-gray-500 italic line-clamp-2" title="${est.notes.replace(/"/g, '&quot;')}">${est.notes.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</span>` : '<span class="text-xs text-gray-300">—</span>'}</td>
            <td class="px-6 py-4">
                <div class="flex items-center justify-end gap-1">
                    <button onclick="editEstimate('${est.id}')" title="Edit" class="p-2 text-gray-400 hover:text-brand-600 hover:bg-brand-50 rounded-lg transition-colors">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
                    </button>
                    <button onclick="viewEstimatePDF('${est.id}')" title="Preview" class="p-2 text-gray-400 hover:text-brand-600 hover:bg-brand-50 rounded-lg transition-colors">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
                    </button>
                    ${est.status !== 'converted' ? `
                    <button onclick="approveEstimate('${est.id}')" title="${est.status === 'approved' ? 'Already Approved' : 'Approve'}" class="p-2 text-gray-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg transition-colors">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
                    </button>
                    <button onclick="convertEstimateToInvoice('${est.id}')" title="Convert to Invoice" class="p-2 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4"/></svg>
                    </button>
                    ` : `
                    <span class="px-2 text-xs text-gray-400 italic">Converted</span>
                    `}
                    <button onclick="archiveEstimate('${est.id}')" title="Archive" class="p-2 text-gray-400 hover:text-amber-600 hover:bg-amber-50 rounded-lg transition-colors">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"/></svg>
                    </button>
                </div>
            </td>
        </tr>
    `).join('');
}

function filterEstimates() {
    renderEstimatesList();
}

function getEstimateStatusBadge(status) {
    const styles = {
        draft: 'bg-gray-100 text-gray-600',
        sent: 'bg-blue-100 text-blue-700',
        approved: 'bg-emerald-100 text-emerald-700',
        rejected: 'bg-red-100 text-red-700',
        converted: 'bg-purple-100 text-purple-700',
        archived: 'bg-amber-100 text-amber-700'
    };
    return `<span class="status-badge ${styles[status] || styles.draft}">${status}</span>`;
}

function approveEstimate(id) {
    const est = state.estimates.find(i => i.id === id);
    if (!est) return;
    if (est.status === 'approved') {
        est.status = 'draft';
        showToast('Estimate reverted to draft');
    } else {
        est.status = 'approved';
        showToast('Estimate approved! You can now convert it to an invoice.');
    }
    saveToStorage();
    renderEstimatesList();
    updateDashboard();
}

function convertEstimateToInvoice(id) {
    const est = state.estimates.find(i => i.id === id);
    if (!est) return;

    if (est.status !== 'approved' && !confirm('This estimate has not been approved yet. Convert to invoice anyway?')) {
        return;
    }

    // Create a new invoice from the estimate data
    const newInvoice = {
        id: generateId(),
        fromCompany: est.fromCompany,
        fromName: est.fromName,
        fromEmail: est.fromEmail,
        fromPhone: est.fromPhone,
        fromAddress: est.fromAddress,
        toCompany: est.toCompany,
        toName: est.toName,
        toEmail: est.toEmail,
        toPhone: est.toPhone,
        toAddress1: est.toAddress1,
        toAddress2: est.toAddress2,
        toCity: est.toCity,
        toState: est.toState,
        toZip: est.toZip,
        toCountry: est.toCountry,
        invoiceNumber: getNextInvoiceNumber(),
        date: getTodayDate(),
        dueDate: getDueDate(state.settings.paymentTerms),
        taxRate: est.taxRate,
        discountValue: est.discountValue || 0,
        discountType: est.discountType || 'percent',
        discountAmount: est.discountAmount || 0,
        lineItems: JSON.parse(JSON.stringify(est.lineItems)),
        subtotal: est.subtotal,
        tax: est.tax,
        total: est.total,
        memo: est.memo,
        status: 'draft',
        convertedFromEstimate: est.invoiceNumber,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

    state.invoices.push(newInvoice);

    // Mark estimate as converted
    est.status = 'converted';
    est.convertedToInvoice = newInvoice.invoiceNumber;
    est.updatedAt = new Date().toISOString();

    saveToStorage();
    renderEstimatesList();
    updateDashboard();
    showToast(`Estimate converted to Invoice ${newInvoice.invoiceNumber}`);

    // Open the new invoice for editing
    state.currentFormMode = 'invoice';
    loadInvoiceToForm(newInvoice);
    showView('create');
}

function archiveEstimate(id) {
    if (!confirm('Archive this estimate? You can find it later under the Archived filter.')) return;
    const est = state.estimates.find(i => i.id === id);
    if (!est) return;
    est.status = 'archived';
    est.updatedAt = new Date().toISOString();
    saveToStorage();
    renderEstimatesList();
    updateDashboard();
    showToast('Estimate archived', 'info');
}

// --------------- Clients ---------------
let editingClientId = null;

function renderClients() {
    const grid = document.getElementById('clients-grid');

    if (state.clients.length === 0) {
        grid.innerHTML = '<div class="col-span-full text-center py-12 text-gray-400 text-sm">No clients yet. Add your first client to get started.</div>';
        return;
    }

    grid.innerHTML = state.clients.map(c => {
        const invoiceCount = state.invoices.filter(i => i.toCompany === c.company).length;
        const totalBilled = state.invoices.filter(i => i.toCompany === c.company).reduce((s, i) => s + (i.total || 0), 0);
        return `
            <div class="bg-white rounded-xl border border-gray-200 p-6 card-hover">
                <div class="flex items-start justify-between mb-4">
                    <div class="w-10 h-10 bg-brand-100 rounded-full flex items-center justify-center text-brand-600 font-bold text-sm">
                        ${(c.company || 'C').charAt(0).toUpperCase()}
                    </div>
                    <div class="flex gap-1">
                        <button onclick="editClient('${c.id}')" class="p-1.5 text-gray-400 hover:text-brand-600 transition-colors">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
                        </button>
                        <button onclick="deleteClient('${c.id}')" class="p-1.5 text-gray-400 hover:text-red-500 transition-colors">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
                        </button>
                    </div>
                </div>
                <h3 class="text-base font-bold text-gray-900 mb-1">${c.company}</h3>
                <p class="text-sm text-gray-500 mb-3">${c.name || '—'}</p>
                <div class="space-y-1 text-xs text-gray-500">
                    ${c.email ? `<div class="flex items-center gap-1.5"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>${c.email}</div>` : ''}
                    ${c.phone ? `<div class="flex items-center gap-1.5"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"/></svg>${c.phone}</div>` : ''}
                </div>
                <div class="flex items-center gap-4 mt-4 pt-4 border-t border-gray-100">
                    <div class="text-xs"><span class="font-semibold text-gray-700">${invoiceCount}</span> <span class="text-gray-400">invoices</span></div>
                    <div class="text-xs"><span class="font-semibold text-gray-700">${formatCurrency(totalBilled)}</span> <span class="text-gray-400">billed</span></div>
                </div>
            </div>
        `;
    }).join('');
}

function showAddClientForm() {
    editingClientId = null;
    document.getElementById('client-form-title').textContent = 'Add New Client';
    document.getElementById('client-company').value = '';
    document.getElementById('client-name').value = '';
    document.getElementById('client-email').value = '';
    document.getElementById('client-phone').value = '';
    document.getElementById('client-address1').value = '';
    document.getElementById('client-address2').value = '';
    document.getElementById('client-city').value = '';
    document.getElementById('client-state').value = '';
    document.getElementById('client-zip').value = '';
    document.getElementById('client-country').value = 'US';
    document.getElementById('add-client-form').classList.remove('hidden');
}

function hideAddClientForm() {
    document.getElementById('add-client-form').classList.add('hidden');
    editingClientId = null;
}

function editClient(id) {
    const c = state.clients.find(cl => cl.id === id);
    if (!c) return;
    editingClientId = id;
    document.getElementById('client-form-title').textContent = 'Edit Client';
    document.getElementById('client-company').value = c.company || '';
    document.getElementById('client-name').value = c.name || '';
    document.getElementById('client-email').value = c.email || '';
    document.getElementById('client-phone').value = c.phone || '';
    document.getElementById('client-address1').value = c.address1 || '';
    document.getElementById('client-address2').value = c.address2 || '';
    document.getElementById('client-city').value = c.city || '';
    document.getElementById('client-state').value = c.state || '';
    document.getElementById('client-zip').value = c.zip || '';
    document.getElementById('client-country').value = c.country || 'US';
    document.getElementById('add-client-form').classList.remove('hidden');
}

function saveClient() {
    const company = document.getElementById('client-company').value.trim();
    if (!company) {
        showToast('Company name is required', 'warning');
        return;
    }

    const clientData = {
        company,
        name: document.getElementById('client-name').value.trim(),
        email: document.getElementById('client-email').value.trim(),
        phone: document.getElementById('client-phone').value.trim(),
        address1: document.getElementById('client-address1').value.trim(),
        address2: document.getElementById('client-address2').value.trim(),
        city: document.getElementById('client-city').value.trim(),
        state: document.getElementById('client-state').value.trim(),
        zip: document.getElementById('client-zip').value.trim(),
        country: document.getElementById('client-country').value.trim()
    };

    if (editingClientId) {
        const idx = state.clients.findIndex(c => c.id === editingClientId);
        if (idx !== -1) {
            state.clients[idx] = { ...state.clients[idx], ...clientData, updatedAt: new Date().toISOString() };
        }
        showToast('Client updated');
    } else {
        state.clients.push({
            id: generateId(),
            ...clientData,
            createdAt: new Date().toISOString()
        });
        showToast('Client added');
    }

    saveToStorage();
    hideAddClientForm();
    renderClients();
}

function deleteClient(id) {
    if (!confirm('Delete this client?')) return;
    state.clients = state.clients.filter(c => c.id !== id);
    saveToStorage();
    renderClients();
    showToast('Client deleted', 'info');
}

// --------------- From Business Info (Read-Only Display) ---------------
function renderFromBusinessInfo() {
    const el = document.getElementById('from-business-display');
    if (!el) return;
    const s = state.settings;
    let html = '';
    if (s.company) html += `<div class="font-semibold text-gray-900">${s.company}</div>`;
    if (s.address) html += `<div class="text-gray-500">${s.address.replace(/\n/g, '<br>')}</div>`;
    if (s.email) html += `<div>${s.email}</div>`;
    if (s.phone) html += `<div>${s.phone}</div>`;
    if (!html) html = '<div class="text-gray-400 italic">No business info set. Go to Settings to configure.</div>';
    el.innerHTML = html;
}

// --------------- Services / Products CRUD ---------------
function showAddServiceForm() {
    document.getElementById('service-edit-id').value = '';
    document.getElementById('service-name').value = '';
    document.getElementById('service-description').value = '';
    document.getElementById('service-rate').value = '';
    document.getElementById('service-form-title').textContent = 'Add New Service';
    document.getElementById('add-service-form').classList.remove('hidden');
}

function hideAddServiceForm() {
    document.getElementById('add-service-form').classList.add('hidden');
}

function editService(id) {
    const svc = state.services.find(s => s.id === id);
    if (!svc) return;
    document.getElementById('service-edit-id').value = svc.id;
    document.getElementById('service-name').value = svc.name || '';
    document.getElementById('service-description').value = svc.description || '';
    document.getElementById('service-rate').value = svc.rate || '';
    document.getElementById('service-form-title').textContent = 'Edit Service';
    document.getElementById('add-service-form').classList.remove('hidden');
}

function saveService() {
    const name = document.getElementById('service-name').value.trim();
    const description = document.getElementById('service-description').value.trim();
    const rate = parseFloat(document.getElementById('service-rate').value) || 0;
    const editId = document.getElementById('service-edit-id').value;

    if (!name) {
        showToast('Service name is required', 'warning');
        return;
    }

    if (editId) {
        // Update existing
        const svc = state.services.find(s => s.id === editId);
        if (svc) {
            svc.name = name;
            svc.description = description;
            svc.rate = rate;
        }
        showToast('Service updated');
    } else {
        // Add new
        state.services.push({
            id: 'svc_' + Date.now(),
            name,
            description,
            rate
        });
        showToast('Service added');
    }

    saveToStorage();
    renderServicesList();
    hideAddServiceForm();
}

function deleteService(id) {
    if (!confirm('Delete this service?')) return;
    state.services = state.services.filter(s => s.id !== id);
    saveToStorage();
    renderServicesList();
    showToast('Service deleted', 'info');
}

function renderServicesList() {
    const container = document.getElementById('services-list');
    if (!container) return;

    if (state.services.length === 0) {
        container.innerHTML = '<div class="text-center py-6 text-gray-400 text-sm">No services saved yet. Add your first service to get started.</div>';
        return;
    }

    container.innerHTML = state.services
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(svc => `
            <div class="flex items-center justify-between p-3 bg-surface-50 rounded-lg border border-gray-100">
                <div class="flex-1 min-w-0">
                    <div class="font-medium text-sm text-gray-900">${svc.name}</div>
                    ${svc.description ? `<div class="text-xs text-gray-500 truncate">${svc.description}</div>` : ''}
                </div>
                <div class="flex items-center gap-3 ml-4">
                    <span class="text-sm font-semibold text-brand-700">${formatCurrency(svc.rate)}</span>
                    <button onclick="editService('${svc.id}')" class="p-1 text-gray-400 hover:text-brand-600 transition-colors" title="Edit">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/></svg>
                    </button>
                    <button onclick="deleteService('${svc.id}')" class="p-1 text-gray-400 hover:text-red-500 transition-colors" title="Delete">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
                    </button>
                </div>
            </div>
        `).join('');
}

// --------------- Service Library View ---------------
function showAddServiceFormLibrary() {
    document.getElementById('library-service-edit-id').value = '';
    document.getElementById('library-service-name').value = '';
    document.getElementById('library-service-description').value = '';
    document.getElementById('library-service-rate').value = '';
    document.getElementById('library-service-form-title').textContent = 'Add New Service';
    document.getElementById('library-service-form').classList.remove('hidden');
}

function hideAddServiceFormLibrary() {
    document.getElementById('library-service-form').classList.add('hidden');
}

function editServiceLibrary(id) {
    const svc = state.services.find(s => s.id === id);
    if (!svc) return;
    document.getElementById('library-service-edit-id').value = svc.id;
    document.getElementById('library-service-name').value = svc.name || '';
    document.getElementById('library-service-description').value = svc.description || '';
    document.getElementById('library-service-rate').value = svc.rate || '';
    document.getElementById('library-service-form-title').textContent = 'Edit Service';
    document.getElementById('library-service-form').classList.remove('hidden');
}

function saveServiceLibrary() {
    const name = document.getElementById('library-service-name').value.trim();
    const description = document.getElementById('library-service-description').value.trim();
    const rate = parseFloat(document.getElementById('library-service-rate').value) || 0;
    const editId = document.getElementById('library-service-edit-id').value;

    if (!name) {
        showToast('Service name is required', 'warning');
        return;
    }

    if (editId) {
        const svc = state.services.find(s => s.id === editId);
        if (svc) {
            svc.name = name;
            svc.description = description;
            svc.rate = rate;
        }
        showToast('Service updated');
    } else {
        state.services.push({
            id: 'svc_' + Date.now(),
            name,
            description,
            rate
        });
        showToast('Service added');
    }

    saveToStorage();
    renderServicesLibrary();
    renderServicesList();
    hideAddServiceFormLibrary();
}

function deleteServiceLibrary(id) {
    if (!confirm('Delete this service?')) return;
    state.services = state.services.filter(s => s.id !== id);
    saveToStorage();
    renderServicesLibrary();
    renderServicesList();
    showToast('Service deleted', 'info');
}

function duplicateServiceLibrary(id) {
    const svc = state.services.find(s => s.id === id);
    if (!svc) return;
    const dupe = {
        id: generateId(),
        name: svc.name + ' (Copy)',
        description: svc.description || '',
        rate: svc.rate || 0,
        createdAt: new Date().toISOString()
    };
    state.services.push(dupe);
    saveToStorage();
    renderServicesLibrary();
    renderServicesList();
    showToast(`Service "${dupe.name}" created`);
}

function getServiceUsageCount(serviceId) {
    let count = 0;
    state.invoices.forEach(inv => {
        (inv.lineItems || []).forEach(li => {
            if (li.serviceId === serviceId) count++;
        });
    });
    state.estimates.forEach(est => {
        (est.lineItems || []).forEach(li => {
            if (li.serviceId === serviceId) count++;
        });
    });
    return count;
}

function renderServicesLibrary() {
    const container = document.getElementById('services-library-container');
    if (!container) return;

    if (state.services.length === 0) {
        container.innerHTML = `
            <div class="text-center py-16">
                <div class="w-16 h-16 bg-surface-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
                    <svg class="w-8 h-8 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"/></svg>
                </div>
                <h3 class="text-lg font-semibold text-gray-900 mb-1">No services yet</h3>
                <p class="text-sm text-gray-500 mb-4">Add your first service to quickly populate invoice line items.</p>
                <button onclick="showAddServiceFormLibrary()" class="bg-brand-600 text-white px-5 py-2.5 rounded-lg text-sm font-semibold hover:bg-brand-700 transition-colors inline-flex items-center gap-2">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
                    Add Service
                </button>
            </div>`;
        return;
    }

    const sorted = [...state.services].sort((a, b) => a.name.localeCompare(b.name));

    container.innerHTML = `
        <table class="w-full">
            <thead>
                <tr class="border-b border-gray-200 bg-surface-50">
                    <th class="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-6 py-3">Service</th>
                    <th class="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-6 py-3">Description</th>
                    <th class="text-right text-xs font-semibold text-gray-500 uppercase tracking-wider px-6 py-3">Rate</th>
                    <th class="text-center text-xs font-semibold text-gray-500 uppercase tracking-wider px-6 py-3">Used</th>
                    <th class="text-right text-xs font-semibold text-gray-500 uppercase tracking-wider px-6 py-3 w-28">Actions</th>
                </tr>
            </thead>
            <tbody class="divide-y divide-gray-100">
                ${sorted.map(svc => {
                    const usage = getServiceUsageCount(svc.id);
                    return `
                    <tr class="hover:bg-surface-50 transition-colors">
                        <td class="px-6 py-4">
                            <div class="font-medium text-sm text-gray-900">${svc.name}</div>
                        </td>
                        <td class="px-6 py-4">
                            <div class="text-sm text-gray-500 truncate max-w-xs">${svc.description || '<span class="text-gray-300 italic">No description</span>'}</div>
                        </td>
                        <td class="px-6 py-4 text-right">
                            <span class="text-sm font-semibold text-brand-700">${formatCurrency(svc.rate)}</span>
                        </td>
                        <td class="px-6 py-4 text-center">
                            <span class="inline-flex items-center justify-center px-2 py-0.5 rounded-full text-xs font-medium ${usage > 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-400'}">${usage} ${usage === 1 ? 'time' : 'times'}</span>
                        </td>
                        <td class="px-6 py-4 text-right">
                            <div class="flex items-center justify-end gap-2">
                                <button onclick="editServiceLibrary('${svc.id}')" class="p-1.5 text-gray-400 hover:text-brand-600 hover:bg-brand-50 rounded-lg transition-colors" title="Edit">
                                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/></svg>
                                </button>
                                <button onclick="duplicateServiceLibrary('${svc.id}')" class="p-1.5 text-gray-400 hover:text-brand-600 hover:bg-brand-50 rounded-lg transition-colors" title="Duplicate">
                                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
                                </button>
                                <button onclick="deleteServiceLibrary('${svc.id}')" class="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors" title="Delete">
                                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
                                </button>
                            </div>
                        </td>
                    </tr>`;
                }).join('')}
            </tbody>
        </table>
        <div class="px-6 py-3 bg-surface-50 border-t border-gray-200 text-xs text-gray-500">
            ${state.services.length} service${state.services.length !== 1 ? 's' : ''} saved
        </div>`;
}

// --------------- Settings ---------------
function populateSettingsForm() {
    document.getElementById('settings-company').value = state.settings.company || '';
    document.getElementById('settings-name').value = state.settings.name || '';
    document.getElementById('settings-email').value = state.settings.email || '';
    document.getElementById('settings-phone').value = state.settings.phone || '';
    document.getElementById('settings-address').value = state.settings.address || '';
    document.getElementById('settings-tax').value = state.settings.taxRate ?? 0;
    document.getElementById('settings-terms').value = state.settings.paymentTerms ?? 30;
    document.getElementById('settings-prefix').value = state.settings.invoicePrefix || 'INV-';
    document.getElementById('settings-est-prefix').value = state.settings.estimatePrefix || 'EST-';
    document.getElementById('settings-currency').value = state.settings.currency || 'USD';
    document.getElementById('settings-memo').value = state.settings.memo || '';
    document.getElementById('settings-paypal').value = state.settings.paypalMe || '';
    updateLogoPreview();
    // Populate GitHub settings
    if (githubConfig.repo) {
        const repoInput = document.getElementById('github-repo');
        if (repoInput && !repoInput.disabled) repoInput.value = githubConfig.repo;
    }
    updateGitHubSettingsUI();
}

function saveSettings() {
    // Preserve non-form settings (logo, darkMode, lastBackupDate)
    const preserved = {
        logo: state.settings.logo,
        darkMode: state.settings.darkMode,
        lastBackupDate: state.settings.lastBackupDate
    };
    state.settings = {
        ...preserved,
        company: document.getElementById('settings-company').value.trim(),
        name: document.getElementById('settings-name').value.trim(),
        email: document.getElementById('settings-email').value.trim(),
        phone: document.getElementById('settings-phone').value.trim(),
        address: document.getElementById('settings-address').value.trim(),
        taxRate: isNaN(parseFloat(document.getElementById('settings-tax').value)) ? 0 : parseFloat(document.getElementById('settings-tax').value),
        paymentTerms: parseInt(document.getElementById('settings-terms').value) || 30,
        invoicePrefix: document.getElementById('settings-prefix').value.trim() || 'INV-',
        estimatePrefix: document.getElementById('settings-est-prefix').value.trim() || 'EST-',
        currency: document.getElementById('settings-currency').value,
        memo: document.getElementById('settings-memo').value.trim(),
        paypalMe: document.getElementById('settings-paypal').value.trim().replace(/^(https?:\/\/)?(www\.)?(paypal\.me|paypal\.biz)\/?/i, '')
    };
    saveToStorage();
    showToast('Settings saved');
}

// --------------- Auto-Backup Reminder ---------------
function checkBackupReminder() {
    const banner = document.getElementById('backup-reminder');
    if (!banner) return;
    const lastBackup = state.settings.lastBackupDate;
    if (!lastBackup) {
        document.getElementById('backup-reminder-text').textContent = "You haven't backed up your data yet!";
        banner.classList.remove('hidden');
        return;
    }
    const daysSince = Math.floor((Date.now() - new Date(lastBackup).getTime()) / (1000 * 60 * 60 * 24));
    if (daysSince >= 7) {
        document.getElementById('backup-reminder-text').textContent = `It's been ${daysSince} days since your last backup.`;
        banner.classList.remove('hidden');
    } else {
        banner.classList.add('hidden');
    }
}

function backupNow() {
    exportAllData();
    state.settings.lastBackupDate = new Date().toISOString();
    saveToStorage();
    document.getElementById('backup-reminder').classList.add('hidden');
}

function dismissBackupReminder() {
    document.getElementById('backup-reminder').classList.add('hidden');
}

// --------------- Company Logo ---------------
function handleLogoUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
        showToast('Please select an image file', 'warning');
        return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
        state.settings.logo = e.target.result;
        saveToStorage();
        updateLogoPreview();
        showToast('Logo uploaded');
    };
    reader.readAsDataURL(file);
    event.target.value = '';
}

function removeLogo() {
    state.settings.logo = null;
    saveToStorage();
    updateLogoPreview();
    showToast('Logo removed', 'info');
}

function updateLogoPreview() {
    const preview = document.getElementById('logo-preview');
    const removeBtn = document.getElementById('remove-logo-btn');
    if (state.settings.logo) {
        preview.innerHTML = `<img src="${state.settings.logo}" class="w-full h-full object-contain">`;
        removeBtn.classList.remove('hidden');
    } else {
        preview.innerHTML = '<svg class="w-8 h-8 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>';
        removeBtn.classList.add('hidden');
    }
}

// --------------- Export / Import ---------------
function exportAllData() {
    const data = JSON.stringify({ invoices: state.invoices, estimates: state.estimates, clients: state.clients, services: state.services, expenses: state.expenses, settings: state.settings }, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `invoiceflow-backup-${getTodayDate()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Data exported');
}

function importData() {
    document.getElementById('import-file').click();
}

function handleImport(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const data = JSON.parse(e.target.result);
            if (data.invoices) state.invoices = data.invoices;
            if (data.estimates) state.estimates = data.estimates;
            if (data.clients) state.clients = data.clients;
            if (data.services) state.services = data.services;
            if (data.expenses) state.expenses = data.expenses;
            if (data.settings) state.settings = { ...state.settings, ...data.settings };
            saveToStorage();
            populateSettingsForm();
            renderServicesList();
            updateDashboard();
            renderInvoicesList();
            renderEstimatesList();
            renderClients();
            showToast('Data imported successfully');
        } catch (err) {
            showToast('Invalid file format', 'error');
        }
    };
    reader.readAsText(file);
    event.target.value = '';
}

// --------------- Invoice Preview ---------------
function previewInvoice() {
    const data = getFormData();
    const container = document.getElementById('invoice-preview-content');
    const isEstimate = state.currentFormMode === 'estimate';
    const docLabel = isEstimate ? 'ESTIMATE' : 'INVOICE';

    const hasDiscounts = data.lineItems.some(li => li.discountValue > 0);
    const lineItemsHTML = data.lineItems.map(li => {
        const discountLabel = li.discountValue > 0
            ? (li.discountType === 'percent' ? `${li.discountValue}%` : formatCurrency(li.discountValue))
            : '—';
        return `
        <tr class="border-b border-gray-100">
            <td style="padding: 8px 12px; font-size: 11px; color: #374151;">${li.description || '—'}</td>
            <td style="padding: 8px 12px; font-size: 11px; color: #374151; text-align: center;">${li.quantity}</td>
            <td style="padding: 8px 12px; font-size: 11px; color: #374151; text-align: right;">${formatCurrency(li.rate)}</td>
            ${hasDiscounts ? `<td style="padding: 8px 12px; font-size: 11px; color: #ef4444; text-align: center;">${discountLabel}</td>` : ''}
            <td style="padding: 8px 12px; font-size: 11px; color: #111827; font-weight: 600; text-align: right;">${formatCurrency(li.amount)}</td>
        </tr>`;
    }).join('');

    container.innerHTML = `
        <div id="pdf-content" style="padding: 36px; font-family: 'Inter', 'Helvetica Neue', Arial, sans-serif; color: #111827;">
            <!-- Header -->
            <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 28px;">
                <div style="display: flex; align-items: flex-start; gap: 12px;">
                    ${state.settings.logo ? `<img src="${state.settings.logo}" style="width: 48px; height: 48px; object-fit: contain; border-radius: 6px;">` : ''}
                    <div>
                        <h1 style="font-size: 22px; font-weight: 800; color: #1e3a5f; margin: 0 0 2px 0; letter-spacing: -0.5px;">${docLabel}</h1>
                        <div style="font-size: 11px; color: #6b7280;">${data.invoiceNumber}</div>
                    </div>
                </div>
                <div style="text-align: right;">
                    <div style="font-size: 14px; font-weight: 700; color: #1e3a5f; margin-bottom: 3px;">${data.fromCompany || 'Your Company'}</div>
                    <div style="font-size: 10.5px; color: #6b7280; line-height: 1.5;">
                        ${data.fromAddress ? data.fromAddress.replace(/\n/g, '<br>') + '<br>' : ''}
                        ${data.fromEmail ? data.fromEmail + '<br>' : ''}
                        ${data.fromPhone ? data.fromPhone : ''}
                    </div>
                </div>
            </div>

            <!-- Dates & Client -->
            <div style="display: flex; justify-content: space-between; margin-bottom: 24px; padding: 16px; background: #f8fafc; border-radius: 8px;">
                <div>
                    <div style="font-size: 9px; font-weight: 600; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 5px;">Bill To</div>
                    <div style="font-size: 12px; font-weight: 700; color: #111827; margin-bottom: 2px;">${data.toCompany || '—'}</div>
                    <div style="font-size: 10.5px; color: #6b7280; line-height: 1.5;">
                        ${data.toName ? data.toName + '<br>' : ''}
                        ${data.toEmail ? data.toEmail + '<br>' : ''}
                        ${data.toPhone ? data.toPhone + '<br>' : ''}
                        ${data.toAddress1 ? data.toAddress1 + '<br>' : ''}
                        ${data.toAddress2 ? data.toAddress2 + '<br>' : ''}
                        ${[data.toCity, data.toState].filter(Boolean).join(', ')}${data.toZip ? ' ' + data.toZip : ''}${(data.toCity || data.toState || data.toZip) ? '<br>' : ''}
                        ${data.toCountry && data.toCountry !== 'US' ? data.toCountry : ''}
                    </div>
                </div>
                <div style="text-align: right;">
                    <div style="margin-bottom: 8px;">
                        <div style="font-size: 9px; font-weight: 600; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.05em;">Invoice Date</div>
                        <div style="font-size: 11px; font-weight: 600; color: #111827;">${formatDate(data.date)}</div>
                    </div>
                    ${!isEstimate && data.dueDate ? `<div>
                        <div style="font-size: 9px; font-weight: 600; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.05em;">Due Date</div>
                        <div style="font-size: 11px; font-weight: 600; color: #111827;">${formatDate(data.dueDate)}</div>
                    </div>` : ''}
                </div>
            </div>

            <!-- Line Items Table -->
            <table style="width: 100%; border-collapse: collapse; margin-bottom: 16px;">
                <thead>
                    <tr style="border-bottom: 2px solid #e5e7eb;">
                        <th style="padding: 8px 12px; font-size: 9px; font-weight: 700; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; text-align: left;">Description</th>
                        <th style="padding: 8px 12px; font-size: 9px; font-weight: 700; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; text-align: center;">Qty</th>
                        <th style="padding: 8px 12px; font-size: 9px; font-weight: 700; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; text-align: right;">Rate</th>
                        ${hasDiscounts ? '<th style="padding: 8px 12px; font-size: 9px; font-weight: 700; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; text-align: center;">Discount</th>' : ''}
                        <th style="padding: 8px 12px; font-size: 9px; font-weight: 700; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; text-align: right;">Amount</th>
                    </tr>
                </thead>
                <tbody>
                    ${lineItemsHTML}
                </tbody>
            </table>

            <!-- Totals -->
            <div style="display: flex; justify-content: flex-end; margin-bottom: 24px;">
                <div style="width: 240px;">
                    <div style="display: flex; justify-content: space-between; padding: 5px 0; font-size: 11px;">
                        <span style="color: #6b7280;">Subtotal</span>
                        <span style="font-weight: 600; color: #111827;">${formatCurrency(data.subtotal)}</span>
                    </div>
                    ${(data.discountValue || 0) > 0 ? `<div style="display: flex; justify-content: space-between; padding: 5px 0; font-size: 11px;">
                        <span style="color: #dc2626;">Discount${data.discountType === 'percent' ? ` (${data.discountValue}%)` : ''}</span>
                        <span style="font-weight: 600; color: #dc2626;">-${formatCurrency(data.discountAmount)}</span>
                    </div>` : ''}
                    <div style="display: flex; justify-content: space-between; padding: 5px 0; font-size: 11px;">
                        <span style="color: #6b7280;">Tax (${data.taxRate}%)</span>
                        <span style="font-weight: 600; color: #111827;">${formatCurrency(data.tax)}</span>
                    </div>
                    <div style="display: flex; justify-content: space-between; padding: 8px 0; font-size: 14px; font-weight: 800; border-top: 2px solid #1e3a5f; margin-top: 6px;">
                        <span style="color: #1e3a5f;">Total</span>
                        <span style="color: #1e3a5f;">${formatCurrency(data.total)}</span>
                    </div>
                    ${(() => {
                        let lines = '';
                        const deposit = data.depositAmount || 0;
                        const currentInv = state.currentEditId ? state.invoices.find(i => i.id === state.currentEditId) : null;
                        const payments = currentInv ? (currentInv.payments || []) : [];
                        const hasDeposit = deposit > 0;
                        const hasPayments = payments.length > 0;
                        if (!hasDeposit && !hasPayments) return '';
                        if (hasDeposit) {
                            lines += `<div style="display: flex; justify-content: space-between; padding: 4px 0; font-size: 10px; color: #059669;">
                                <span>Deposit Received${data.depositDate ? ' (' + formatDate(data.depositDate) + ')' : ''}</span>
                                <span>-${formatCurrency(deposit)}</span>
                            </div>`;
                        }
                        if (hasPayments) {
                            lines += payments.map(p => `
                                <div style="display: flex; justify-content: space-between; padding: 4px 0; font-size: 10px; color: #059669;">
                                    <span>Payment (${p.method}) — ${formatDate(p.date)}</span>
                                    <span>-${formatCurrency(p.amount)}</span>
                                </div>
                            `).join('');
                        }
                        const paidTotal = payments.reduce((s, p) => s + (p.amount || 0), 0);
                        const balance = data.total - deposit - paidTotal;
                        lines += `<div style="display: flex; justify-content: space-between; padding: 8px 0; font-size: 13px; font-weight: 800; border-top: 2px solid #1e3a5f; margin-top: 4px;">
                            <span style="color: ${balance > 0 ? '#dc2626' : '#059669'};">Balance Due</span>
                            <span style="color: ${balance > 0 ? '#dc2626' : '#059669'};">${formatCurrency(Math.max(0, balance))}</span>
                        </div>`;
                        return lines;
                    })()}
                </div>
            </div>

            <!-- Memo (invoices only) -->
            ${!isEstimate && data.memo ? `
            <div style="padding: 16px; background: #f8fafc; border-radius: 8px; border-left: 4px solid #2563eb;">
                <div style="font-size: 9px; font-weight: 700; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 5px;">Notes / Payment Instructions</div>
                <div style="font-size: 10.5px; color: #374151; line-height: 1.5; white-space: pre-line;">${data.memo}</div>
            </div>
            ` : ''}

            <!-- Pay Online Button (invoices only, when PayPal is set) -->
            ${!isEstimate && state.settings.paypalMe ? `
            <div style="margin-top: 24px; text-align: center;">
                <a href="https://www.paypal.biz/${state.settings.paypalMe}" target="_blank" style="display: inline-block; padding: 12px 32px; background: #0070ba; color: #ffffff; font-size: 12px; font-weight: 700; text-decoration: none; border-radius: 6px; letter-spacing: 0.02em;">
                    Pay ${formatCurrency(data.total || 0)} Online via PayPal
                </a>
                <div style="font-size: 8px; color: #9ca3af; margin-top: 6px;">Click above to pay securely via PayPal</div>
            </div>
            ` : ''}

            <!-- W-9 Link (invoices only) -->
            ${!isEstimate ? `
            <div style="margin-top: 24px; padding: 12px 16px; background: #f0f9ff; border-radius: 6px; border: 1px solid #bae6fd;">
                <div style="font-size: 10px; color: #0369a1;">
                    <strong>W-9:</strong> A copy of our W-9 is available at
                    <a href="https://www.dropbox.com/scl/fi/ojgxyf91eoz04fi4l9hil/Kelleghan-Productions-Inc-W9.pdf?rlkey=8ga9l53je36r20l1sdfo3cb87&dl=0" target="_blank" style="color: #2563eb; text-decoration: underline;">Kelleghan Productions Inc. W-9 (PDF)</a>
                </div>
            </div>
            ` : ''}

            <!-- Footer -->
            <div style="margin-top: 16px; padding-top: 12px; border-top: 1px solid #e5e7eb; text-align: center; font-size: 10px; color: #9ca3af;">
                Thank you for your business!
            </div>
        </div>
    `;

    showView('preview');
}

// --------------- Partial Payments ---------------
let currentPaymentInvoiceId = null;

function getBalanceDue(inv) {
    const deposit = inv.depositAmount || 0;
    const payments = inv.payments || [];
    const paid = payments.reduce((s, p) => s + (p.amount || 0), 0);
    return (inv.total || 0) - deposit - paid;
}

function recordPayment(id) {
    const inv = state.invoices.find(i => i.id === id);
    if (!inv) return;
    currentPaymentInvoiceId = id;
    const balance = getBalanceDue(inv);
    document.getElementById('payment-balance-info').innerHTML = `<strong>${inv.invoiceNumber}</strong> — Total: ${formatCurrency(inv.total)}, Balance Due: <strong>${formatCurrency(balance)}</strong>`;
    document.getElementById('payment-amount').value = balance > 0 ? balance.toFixed(2) : '';
    document.getElementById('payment-date').value = getTodayDate();
    document.getElementById('payment-method').value = 'ACH';
    document.getElementById('payment-note').value = '';

    // Show payment history
    const payments = inv.payments || [];
    const historySection = document.getElementById('payment-history');
    const historyList = document.getElementById('payment-history-list');
    if (payments.length > 0) {
        historySection.classList.remove('hidden');
        historyList.innerHTML = payments.map(p => `
            <div class="flex items-center justify-between p-2 bg-surface-50 rounded-lg text-sm">
                <div>
                    <span class="font-medium text-gray-900">${formatCurrency(p.amount)}</span>
                    <span class="text-gray-400 mx-1">via</span>
                    <span class="text-gray-600">${p.method}</span>
                    ${p.note ? `<span class="text-gray-400 ml-1">— ${p.note}</span>` : ''}
                </div>
                <span class="text-xs text-gray-500">${formatDate(p.date)}</span>
            </div>
        `).join('');
    } else {
        historySection.classList.add('hidden');
    }

    document.getElementById('payment-modal').classList.remove('hidden');
}

function closePaymentModal() {
    document.getElementById('payment-modal').classList.add('hidden');
    currentPaymentInvoiceId = null;
}

function savePayment() {
    if (!currentPaymentInvoiceId) return;
    const inv = state.invoices.find(i => i.id === currentPaymentInvoiceId);
    if (!inv) return;

    const amount = parseFloat(document.getElementById('payment-amount').value) || 0;
    if (amount <= 0) {
        showToast('Enter a valid payment amount', 'warning');
        return;
    }

    if (!inv.payments) inv.payments = [];
    inv.payments.push({
        id: generateId(),
        amount,
        date: document.getElementById('payment-date').value,
        method: document.getElementById('payment-method').value,
        note: document.getElementById('payment-note').value.trim()
    });

    // Update status based on balance
    const balance = getBalanceDue(inv);
    if (balance <= 0) {
        inv.status = 'paid';
    } else if (inv.status === 'paid') {
        inv.status = 'sent'; // shouldn't happen but just in case
    }

    inv.updatedAt = new Date().toISOString();
    saveToStorage();
    closePaymentModal();
    renderInvoicesList();
    updateDashboard();
    showToast(`Payment of ${formatCurrency(amount)} recorded`);
}

// --------------- Expense Tracking ---------------
function showAddExpenseForm() {
    document.getElementById('expense-edit-id').value = '';
    document.getElementById('expense-date').value = getTodayDate();
    document.getElementById('expense-category').value = 'Other';
    document.getElementById('expense-vendor').value = '';
    document.getElementById('expense-amount').value = '';
    document.getElementById('expense-description').value = '';
    document.getElementById('expense-form-title').textContent = 'Add Expense';
    document.getElementById('add-expense-form').classList.remove('hidden');
}

function hideAddExpenseForm() {
    document.getElementById('add-expense-form').classList.add('hidden');
}

function editExpense(id) {
    const exp = state.expenses.find(e => e.id === id);
    if (!exp) return;
    document.getElementById('expense-edit-id').value = exp.id;
    document.getElementById('expense-date').value = exp.date || '';
    document.getElementById('expense-category').value = exp.category || 'Other';
    document.getElementById('expense-vendor').value = exp.vendor || '';
    document.getElementById('expense-amount').value = exp.amount || '';
    document.getElementById('expense-description').value = exp.description || '';
    document.getElementById('expense-form-title').textContent = 'Edit Expense';
    document.getElementById('add-expense-form').classList.remove('hidden');
}

function saveExpense() {
    const date = document.getElementById('expense-date').value;
    const category = document.getElementById('expense-category').value;
    const vendor = document.getElementById('expense-vendor').value.trim();
    const amount = parseFloat(document.getElementById('expense-amount').value) || 0;
    const description = document.getElementById('expense-description').value.trim();
    const editId = document.getElementById('expense-edit-id').value;

    if (!amount) {
        showToast('Amount is required', 'warning');
        return;
    }

    if (editId) {
        const idx = state.expenses.findIndex(e => e.id === editId);
        if (idx !== -1) {
            state.expenses[idx] = { ...state.expenses[idx], date, category, vendor, amount, description, updatedAt: new Date().toISOString() };
        }
        showToast('Expense updated');
    } else {
        state.expenses.push({ id: generateId(), date, category, vendor, amount, description, createdAt: new Date().toISOString() });
        showToast('Expense added');
    }

    saveToStorage();
    hideAddExpenseForm();
    renderExpenses();
}

function deleteExpense(id) {
    if (!confirm('Delete this expense?')) return;
    state.expenses = state.expenses.filter(e => e.id !== id);
    saveToStorage();
    renderExpenses();
    showToast('Expense deleted', 'info');
}

function renderExpenses() {
    const tbody = document.getElementById('expenses-table-body');
    if (!tbody) return;

    const sorted = [...state.expenses].sort((a, b) => new Date(b.date || b.createdAt) - new Date(a.date || a.createdAt));

    if (sorted.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="px-6 py-12 text-center text-gray-400 text-sm">No expenses recorded yet.</td></tr>';
        return;
    }

    const categoryColors = {
        Freelancer: 'bg-purple-100 text-purple-700',
        Equipment: 'bg-blue-100 text-blue-700',
        Software: 'bg-cyan-100 text-cyan-700',
        Travel: 'bg-green-100 text-green-700',
        Office: 'bg-amber-100 text-amber-700',
        Marketing: 'bg-pink-100 text-pink-700',
        Other: 'bg-gray-100 text-gray-600'
    };

    tbody.innerHTML = sorted.map(exp => `
        <tr class="hover:bg-gray-50 transition-colors">
            <td class="px-6 py-4 text-sm text-gray-600">${formatDate(exp.date)}</td>
            <td class="px-6 py-4"><span class="status-badge ${categoryColors[exp.category] || categoryColors.Other}">${exp.category}</span></td>
            <td class="px-6 py-4 text-sm font-medium text-gray-900">${exp.vendor || '—'}</td>
            <td class="px-6 py-4 text-sm text-gray-500">${exp.description || '—'}</td>
            <td class="px-6 py-4 text-sm font-semibold text-gray-900 text-right">${formatCurrency(exp.amount)}</td>
            <td class="px-6 py-4 text-right">
                <div class="flex items-center justify-end gap-1">
                    <button onclick="editExpense('${exp.id}')" class="p-2 text-gray-400 hover:text-brand-600 hover:bg-brand-50 rounded-lg transition-colors" title="Edit">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
                    </button>
                    <button onclick="deleteExpense('${exp.id}')" class="p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors" title="Delete">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
                    </button>
                </div>
            </td>
        </tr>
    `).join('');
}

// --------------- Late Payment Reminders ---------------
function sendReminder(id) {
    const inv = state.invoices.find(i => i.id === id);
    if (!inv) return;
    const daysOverdue = Math.floor((Date.now() - new Date(inv.dueDate + 'T00:00:00').getTime()) / (1000 * 60 * 60 * 24));
    const subject = `Payment Reminder: ${inv.invoiceNumber} — ${daysOverdue} days overdue`;
    const balance = getBalanceDue(inv);
    let body = `Hi ${inv.toName || 'there'},\n\nThis is a friendly reminder that invoice ${inv.invoiceNumber} for ${formatCurrency(inv.total)} was due on ${formatDate(inv.dueDate)} and is now ${daysOverdue} days past due.`;
    if (state.settings.paypalMe && balance > 0) {
        body += `\n\nPay ${formatCurrency(balance)} online: https://www.paypal.biz/${state.settings.paypalMe}`;
    }
    body += `\n\nPlease arrange payment at your earliest convenience.\n\nThank you,\n${state.settings.name || state.settings.company || ''}`;
    const mailtoLink = `mailto:${encodeURIComponent(inv.toEmail || '')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    window.open(mailtoLink, '_blank');
    inv.lastReminderDate = new Date().toISOString().split('T')[0];
    saveToStorage();
    renderInvoicesList();
    showToast('Reminder email opened');
}

// --------------- Print ---------------
function printInvoice() {
    window.print();
}

// --------------- PDF Download ---------------
function downloadPDF() {
    const data = getFormData();

    // Build preview first if not already visible
    if (state.currentView !== 'preview') {
        previewInvoice();
    }

    const element = document.getElementById('pdf-content');
    if (!element) {
        showToast('Preview the invoice first', 'warning');
        return;
    }

    const opt = {
        margin: 0,
        filename: `${data.invoiceNumber || 'invoice'}.pdf`,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true, letterRendering: true },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
        pagebreak: { mode: ['avoid-all', 'css', 'legacy'] }
    };

    showToast('Generating PDF...', 'info');

    html2pdf().set(opt).from(element).save().then(() => {
        showToast('PDF downloaded');
    }).catch(() => {
        showToast('PDF generation failed', 'error');
    });
}

// --------------- Email ---------------
function openEmailModal() {
    const data = getFormData();
    const isEstimate = state.currentFormMode === 'estimate';
    const docType = isEstimate ? 'Estimate' : 'Invoice';
    const modal = document.getElementById('email-modal');
    modal.classList.remove('hidden');

    document.getElementById('email-to').value = data.toEmail || '';
    document.getElementById('email-subject').value = `${docType} ${data.invoiceNumber} from ${data.fromCompany || data.fromName || 'Us'}`;

    let body = `Hi ${data.toName || 'there'},\n\nPlease find attached ${docType.toLowerCase()} ${data.invoiceNumber} for ${formatCurrency(data.total)}`;
    if (!isEstimate && data.dueDate) {
        body += `, due by ${formatDate(data.dueDate)}`;
    }
    body += `.`;
    // Show deposit info if applicable
    if (!isEstimate && data.depositAmount > 0) {
        const balanceDue = data.total - data.depositAmount;
        body += `\n\nDeposit of ${formatCurrency(data.depositAmount)} received - balance due: ${formatCurrency(Math.max(0, balanceDue))}.`;
    }
    // Add PayPal payment link for invoices
    if (!isEstimate && state.settings.paypalMe) {
        const displayAmount = data.depositAmount > 0 ? Math.max(0, data.total - data.depositAmount) : data.total;
        body += `\n\nPay ${formatCurrency(displayAmount)} online: https://www.paypal.biz/${state.settings.paypalMe}`;
    }
    body += `\n\nThank you for your business!`;
    document.getElementById('email-body').value = body;
}

function closeEmailModal(navigate = true) {
    document.getElementById('email-modal').classList.add('hidden');
    if (navigate) {
        state.currentEditId = null;
        const dest = state.currentFormMode === 'estimate' ? 'estimates' : 'invoices';
        showViewDirect(dest);
    }
}

function sendEmail() {
    const to = document.getElementById('email-to').value.trim();
    const subject = document.getElementById('email-subject').value.trim();
    const body = document.getElementById('email-body').value.trim();

    if (!to) {
        showToast('Recipient email is required', 'warning');
        return;
    }

    // Build the invoice preview for PDF generation
    previewInvoice();
    const element = document.getElementById('pdf-content');

    if (element) {
        const data = getFormData();
        const opt = {
            margin: 0,
            filename: `${data.invoiceNumber || 'invoice'}.pdf`,
            image: { type: 'jpeg', quality: 0.98 },
            html2canvas: { scale: 2, useCORS: true, letterRendering: true },
            jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
            pagebreak: { mode: ['avoid-all', 'css', 'legacy'] }
        };
        showToast('Generating PDF...', 'info');
        html2pdf().set(opt).from(element).save().then(() => {
            // Open email client after PDF downloads
            const mailtoLink = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
            window.open(mailtoLink, '_blank');
            showToast('PDF downloaded — attach it to the email');
            finishSendEmail();
        }).catch(() => {
            showToast('PDF generation failed — opening email without attachment', 'error');
            const mailtoLink = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
            window.open(mailtoLink, '_blank');
            finishSendEmail();
        });
    } else {
        const mailtoLink = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
        window.open(mailtoLink, '_blank');
        showToast('Opening email client...');
        finishSendEmail();
    }
}

function finishSendEmail() {
    closeEmailModal(true);
}

// --------------- Recurring Invoices ---------------
function toggleRecurringFields() {
    const enabled = document.getElementById('recurring-enabled').checked;
    document.getElementById('recurring-fields').classList.toggle('hidden', !enabled);
}

function getRecurringFormData() {
    const enabled = document.getElementById('recurring-enabled')?.checked || false;
    if (!enabled) return { isRecurring: false };
    return {
        isRecurring: true,
        recurringFrequency: document.getElementById('recurring-frequency').value,
        recurringEndDate: document.getElementById('recurring-end-date').value || null,
    };
}

function getNextRecurringDate(fromDate, frequency) {
    const d = new Date(fromDate + 'T00:00:00');
    switch (frequency) {
        case 'weekly': d.setDate(d.getDate() + 7); break;
        case 'monthly': d.setMonth(d.getMonth() + 1); break;
        case 'quarterly': d.setMonth(d.getMonth() + 3); break;
    }
    return d.toISOString().split('T')[0];
}

function checkRecurringInvoices() {
    const today = getTodayDate();
    let generated = 0;

    state.invoices.forEach(inv => {
        if (!inv.isRecurring || inv.status === 'archived') return;
        if (inv.recurringEndDate && inv.recurringEndDate < today) return;

        const nextDate = inv.recurringNextDate || getNextRecurringDate(inv.date, inv.recurringFrequency);

        if (nextDate <= today) {
            // Generate the new invoice
            const newInv = {
                ...JSON.parse(JSON.stringify(inv)),
                id: generateId(),
                invoiceNumber: getNextInvoiceNumber(),
                date: nextDate,
                dueDate: getDueDate(state.settings.paymentTerms),
                status: 'draft',
                isRecurring: false,
                recurringNextDate: undefined,
                recurringEndDate: undefined,
                recurringFrequency: undefined,
                payments: [],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                generatedFromRecurring: inv.id
            };
            state.invoices.push(newInv);

            // Update the recurring template's next date
            inv.recurringNextDate = getNextRecurringDate(nextDate, inv.recurringFrequency);
            inv.updatedAt = new Date().toISOString();
            generated++;
        }
    });

    if (generated > 0) {
        saveToStorage();
        showToast(`${generated} recurring invoice${generated > 1 ? 's' : ''} generated`, 'info');
    }
}

// --------------- Bulk Actions ---------------
const selectedInvoices = new Set();

function toggleSelectInvoice(id) {
    if (selectedInvoices.has(id)) {
        selectedInvoices.delete(id);
    } else {
        selectedInvoices.add(id);
    }
    updateBulkActionBar();
}

function toggleSelectAllInvoices() {
    const checkAll = document.getElementById('invoice-select-all');
    const checkboxes = document.querySelectorAll('.invoice-checkbox');
    if (checkAll.checked) {
        checkboxes.forEach(cb => {
            cb.checked = true;
            selectedInvoices.add(cb.dataset.id);
        });
    } else {
        checkboxes.forEach(cb => {
            cb.checked = false;
        });
        selectedInvoices.clear();
    }
    updateBulkActionBar();
}

function updateBulkActionBar() {
    const bar = document.getElementById('bulk-action-bar');
    if (selectedInvoices.size > 0) {
        bar.classList.remove('hidden');
        document.getElementById('bulk-count').textContent = `${selectedInvoices.size} selected`;
    } else {
        bar.classList.add('hidden');
    }
}

function clearBulkSelection() {
    selectedInvoices.clear();
    document.querySelectorAll('.invoice-checkbox').forEach(cb => cb.checked = false);
    const selectAll = document.getElementById('invoice-select-all');
    if (selectAll) selectAll.checked = false;
    updateBulkActionBar();
}

function bulkMarkPaid() {
    if (selectedInvoices.size === 0) return;
    if (!confirm(`Mark ${selectedInvoices.size} invoice(s) as paid?`)) return;
    selectedInvoices.forEach(id => {
        const inv = state.invoices.find(i => i.id === id);
        if (inv && inv.status !== 'archived') {
            inv.status = 'paid';
            inv.updatedAt = new Date().toISOString();
        }
    });
    saveToStorage();
    clearBulkSelection();
    renderInvoicesList();
    updateDashboard();
    showToast('Invoices marked as paid');
}

function bulkArchiveInvoices() {
    if (selectedInvoices.size === 0) return;
    if (!confirm(`Archive ${selectedInvoices.size} invoice(s)?`)) return;
    selectedInvoices.forEach(id => {
        const inv = state.invoices.find(i => i.id === id);
        if (inv) {
            inv.status = 'archived';
            inv.updatedAt = new Date().toISOString();
        }
    });
    saveToStorage();
    clearBulkSelection();
    renderInvoicesList();
    updateDashboard();
    showToast('Invoices archived', 'info');
}

// --------------- Dark Mode ---------------
function toggleDarkMode() {
    const isDark = document.documentElement.classList.toggle('dark');
    state.settings.darkMode = isDark;
    saveToStorage();
    updateDarkModeUI(isDark);
}

function updateDarkModeUI(isDark) {
    document.getElementById('dark-mode-icon-moon').classList.toggle('hidden', isDark);
    document.getElementById('dark-mode-icon-sun').classList.toggle('hidden', !isDark);
    document.getElementById('dark-mode-label').textContent = isDark ? 'Light Mode' : 'Dark Mode';
}

function initDarkMode() {
    if (state.settings.darkMode) {
        document.documentElement.classList.add('dark');
        updateDarkModeUI(true);
    }
}

// --------------- Keyboard Shortcuts ---------------
document.addEventListener('keydown', (e) => {
    // Ctrl/Cmd + S = Save
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (state.currentView === 'create') {
            saveDocument('draft');
        } else if (state.currentView === 'settings') {
            saveSettings();
        }
    }
    // Ctrl/Cmd + N = New invoice
    if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
        e.preventDefault();
        state.currentEditId = null;
        showView('create');
    }
    // Ctrl/Cmd + P = Preview / Download PDF
    if ((e.ctrlKey || e.metaKey) && e.key === 'p') {
        e.preventDefault();
        if (state.currentView === 'create' || state.currentView === 'preview') {
            downloadPDF();
        }
    }
    // Escape = close modal
    if (e.key === 'Escape') {
        closeEmailModal();
        closePaymentModal();
    }
});
