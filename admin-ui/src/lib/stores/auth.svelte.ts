let token = $state<string>(
  typeof window !== 'undefined' ? (localStorage.getItem('psfn_token') ?? '') : ''
);
let authenticated = $derived(!!token);

export function getToken(): string {
  return token;
}

export function isAuthenticated(): boolean {
  return authenticated;
}

export function setToken(t: string) {
  token = t;
  if (typeof window !== 'undefined') {
    localStorage.setItem('psfn_token', t);
    document.cookie = `psfn_token=${t}; path=/; SameSite=Strict`;
  }
}

export function clearToken() {
  token = '';
  if (typeof window !== 'undefined') {
    localStorage.removeItem('psfn_token');
    document.cookie = 'psfn_token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
  }
}
