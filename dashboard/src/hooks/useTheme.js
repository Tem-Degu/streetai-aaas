import { createContext, useContext, useState, useEffect } from 'react';

export const ThemeContext = createContext('dark');

export function useTheme() {
  return useContext(ThemeContext);
}

export function useThemeState() {
  const [theme, setThemeState] = useState(() => {
    try {
      return localStorage.getItem('aaas-theme') || 'dark';
    } catch {
      return 'dark';
    }
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('aaas-theme', theme); } catch {}
  }, [theme]);

  // Set initial theme on mount
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, []);

  const setTheme = (t) => setThemeState(t);
  const toggle = () => setThemeState(t => t === 'dark' ? 'light' : 'dark');

  return { theme, setTheme, toggle };
}
