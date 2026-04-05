/**
 * Session Manager - Manages authentication tokens and session state
 * Provides utilities for token management, auto-refresh, and logout
 */

class SessionManager {
  constructor(options = {}) {
    this.tokenKey = options.tokenKey || 'fs_token';
    this.refreshTokenKey = options.refreshTokenKey || 'fs_refresh_token';
    this.autoRefresh = options.autoRefresh !== false;
    this.refreshThreshold = options.refreshThreshold || 5 * 60 * 1000; // 5 minutes
    this.refreshInterval = options.refreshInterval || 1 * 60 * 1000; // Check every minute
    this.refreshTimerId = null;
    this.listeners = [];

    if (this.autoRefresh) {
      this.startAutoRefresh();
    }
  }

  /**
   * Register a callback for session changes
   */
  on(event, callback) {
    this.listeners.push({ event, callback });
  }

  /**
   * Emit session events
   */
  emit(event, data) {
    this.listeners
      .filter(l => l.event === event)
      .forEach(l => l.callback(data));
  }

  /**
   * Get the current access token
   */
  getToken() {
    return localStorage.getItem(this.tokenKey);
  }

  /**
   * Set the access token
   */
  setToken(token) {
    localStorage.setItem(this.tokenKey, token);
    this.emit('token-changed', { token });
  }

  /**
   * Get the refresh token
   */
  getRefreshToken() {
    return localStorage.getItem(this.refreshTokenKey);
  }

  /**
   * Set the refresh token
   */
  setRefreshToken(token) {
    localStorage.setItem(this.refreshTokenKey, token);
  }

  /**
   * Check if user is authenticated
   */
  isAuthenticated() {
    const token = this.getToken();
    if (!token) return false;
    return !this.isTokenExpired(token);
  }

  /**
   * Get user info from token
   */
  getUserInfo() {
    const token = this.getToken();
    if (!token) return null;

    const payload = this.decodeToken(token);
    if (!payload) return null;

    return {
      id: payload.sub || payload.user_id,
      email: payload.email,
      name: payload.name,
      role: payload.role,
      expiresAt: new Date(payload.exp * 1000),
    };
  }

  /**
   * Decode JWT token
   */
  decodeToken(token) {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      const decoded = JSON.parse(atob(parts[1]));
      return decoded;
    } catch (err) {
      console.error('Failed to decode token:', err);
      return null;
    }
  }

  /**
   * Check if token is expired
   */
  isTokenExpired(token) {
    const payload = this.decodeToken(token);
    if (!payload || !payload.exp) return true;
    return payload.exp * 1000 <= Date.now();
  }

  /**
   * Check if token should be refreshed
   */
  shouldRefreshToken(token) {
    const payload = this.decodeToken(token);
    if (!payload || !payload.exp) return true;
    const expiresAt = payload.exp * 1000;
    return expiresAt - Date.now() <= this.refreshThreshold;
  }

  /**
   * Refresh the access token
   */
  async refreshAccessToken() {
    const refreshToken = this.getRefreshToken();
    if (!refreshToken) {
      this.clear();
      this.emit('session-expired', {});
      return false;
    }

    try {
      const res = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });

      if (!res.ok) {
        this.clear();
        this.emit('session-expired', {});
        return false;
      }

      const data = await res.json();
      if (data.ok && data.access_token) {
        this.setToken(data.access_token);
        if (data.refresh_token) {
          this.setRefreshToken(data.refresh_token);
        }
        this.emit('session-refreshed', { token: data.access_token });
        return true;
      }

      this.clear();
      this.emit('session-expired', {});
      return false;
    } catch (err) {
      console.error('Token refresh failed:', err);
      this.emit('refresh-error', { error: err });
      return false;
    }
  }

  /**
   * Start automatic token refresh
   */
  startAutoRefresh() {
    if (this.refreshTimerId) return;

    this.refreshTimerId = setInterval(async () => {
      const token = this.getToken();
      if (!token) {
        this.stopAutoRefresh();
        return;
      }

      if (this.shouldRefreshToken(token)) {
        await this.refreshAccessToken();
      }
    }, this.refreshInterval);
  }

  /**
   * Stop automatic token refresh
   */
  stopAutoRefresh() {
    if (this.refreshTimerId) {
      clearInterval(this.refreshTimerId);
      this.refreshTimerId = null;
    }
  }

  /**
   * Logout user
   */
  async logout() {
    const token = this.getToken();
    if (token) {
      try {
        await fetch('/api/auth/logout', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        });
      } catch (err) {
        console.error('Logout request failed:', err);
      }
    }

    this.clear();
    this.emit('logged-out', {});
  }

  /**
   * Clear all session data
   */
  clear() {
    localStorage.removeItem(this.tokenKey);
    localStorage.removeItem(this.refreshTokenKey);
    this.stopAutoRefresh();
    this.emit('session-cleared', {});
  }

  /**
   * Get Bearer token for API requests
   */
  getBearerToken() {
    const token = this.getToken();
    return token ? `Bearer ${token}` : '';
  }
}

// Global instance
window.sessionManager = new SessionManager();
