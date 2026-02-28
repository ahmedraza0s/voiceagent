// auth.js
// Authentication helper for frontend

function getToken() {
    return localStorage.getItem('token');
}

function getUser() {
    const userStr = localStorage.getItem('user');
    return userStr ? JSON.parse(userStr) : null;
}

function setAuthData(token, user) {
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(user));
}

function clearAuthData() {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
}

function requireAuth() {
    if (!getToken()) {
        window.location.href = 'index.html';
    }
}

// Intercept fetch calls to include Authorization header
function fetchWithAuth(url, options = {}) {
    const token = getToken();
    const headers = options.headers ? { ...options.headers } : {};
    
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }
    
    const newOptions = { ...options, headers };
    
    return fetch(url, newOptions).then(response => {
        if (response.status === 401 || response.status === 403) {
            clearAuthData();
            window.location.href = 'index.html';
        }
        return response;
    });
}

async function logout() {
    try {
        await fetchWithAuth('/api/auth/logout', { method: 'POST' });
    } catch (e) {
        console.error('Logout failed:', e);
    } finally {
        clearAuthData();
        window.location.href = 'index.html';
    }
}
