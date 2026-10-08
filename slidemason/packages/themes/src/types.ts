export interface ThemeConfig {
  name: string;
  colors: {
    background: string;
    surface: string;
    text: string;
    muted: string;
    primary: string;
    secondary: string;
    accent: string;
    border: string;
    success: string;
    warning: string;
    danger: string;
    gradientStart: string;
    gradientEnd: string;
    chart: [string, string, string, string, string, string];
    glass: string;
  };
  typography: {
    headingFont: string;
    bodyFont: string;
    monoFont: string;
  };
  spacing: {
    slidePadding: string;
    elementGap: string;
  };
  radius: string;
  shadow: {
    sm: string;
    md: string;
    lg: string;
  };
}
