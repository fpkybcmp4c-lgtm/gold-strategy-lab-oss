import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "黄金 · 三个月策略验证",
  description: "个人多品种策略验证：记录每一天，分开检验策略与执行。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
