/**
 * Auth Guard - Protects pages from unauthorized access
 * Include this script at the top of protected pages
 */

class AuthGuard {
  constructor(options = {}) {
    this.loginUrl = options.loginUrl || '/auth/login.html';
    this.tokenKey = options.tokenKey || 'fs_token';
    this.refreshTokenKey = options.refreshTokenKey || 'fs_refresh_token';
    this.autoRefresh = options.autoRefresh !== false; // Default to true
    this.refreshThreshold = options.refreshThreshold || 5 * 60 * 1000; // 5 minutes
  }

  /**
   * Get token from localStorage
   */
  getToken() {
    return localStorage.getItem(this.tokenKey);
  }

  /**
   * Set token in localStorage
   */
  setToken(token) {
    localStorage.setItem(this.tokenKey, token);
  }

  /**
   * Get refresh token
   */
  getRefreshToken() {
    return localStorage.getItem(this.refreshTokenKey);
  }

  /**
   * Set refresh token
   */
  setRefreshToken(token) {
    localStorage.setItem(this.refreshTokenKey, token);
  }

  /**
   * Clear all auth tokens
   */
  clearTokens() {
    localStorage.removeItem(this.tokenKey);
    localStorage.removeItem(this.refreshTokenKey);
  }

  /**
   * Decode JWT token payload
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
   * Check if token should be refreshed (within threshold)
   */
  shouldRefreshToken(token) {
    const payload = this.decodeToken(token);
    if (!payload || !payload.exp) return true;
    const expiresAt = payload.exp * 1000;
    return expiresAt - Date.now() <= this.refreshThreshold;
  }

  /**
   * Refresh the access token using refresh token
   */
  async refreshAccessToken() {
    const refreshToken = this.getRefreshToken();
    if (!refreshToken) return false;

    try {
      const res = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });

      if (!res.ok) {
        this.clearTokens();
        return false;
      }

      const data = await res.json();
      if (data.ok && data.access_token) {
        this.setToken(data.access_token);
        if (data.refresh_token) {
          this.setRefreshToken(data.refresh_token);
        }
        return true;
      }

      this.clearTokens();
      return false;
    } catch (err) {
      console.error('Token refresh failed:', err);
      this.clearTokens();
      return false;
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
    this.clearTokens();
    window.location.href = this.loginUrl;
  }

  /**
   * Check authentication and protect page
   * Returns true if authenticated, false otherwise
   */
  checkAuth() {
    const token = this.getToken();

    // No token - redirect to login
    if (!token) {
      this.redirectToLogin();
      return false;
    }

    // Token is expired - redirect to login
    if (this.isTokenExpired(token)) {
      this.clearTokens();
      this.redirectToLogin();
      return false;
    }

    // Token near expiration - try to refresh
    if (this.autoRefresh && this.shouldRefreshToken(token)) {
      this.refreshAccessToken().catch(err => {
        console.error('Auto-refresh failed:', err);
        this.redirectToLogin();
      });
    }

    return true;
  }

  /**
   * Redirect to login page
   */
  redirectToLogin() {
    window.location.href = `${this.loginUrl}?redirect=${encodeURIComponent(window.location.href)}`;
  }
}

// Auto-check auth on page load if guard is instantiated
// Usage in HTML: <script>new AuthGuard().checkAuth();</script>

// Global instance for use in other scripts
window.authGuard = new AuthGuard();
