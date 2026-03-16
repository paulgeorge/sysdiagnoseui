// Type declarations for CDN-loaded globals (React, ReactDOM, Chart.js, sql.js, Hammer)
// These are loaded via <script> tags in index-dev.html, not via imports

declare const React: typeof import('react');
declare const ReactDOM: typeof import('react-dom');

declare const Chart: {
  register(...items: any[]): void;
  registerables: any[];
  new (ctx: any, config: any): {
    destroy(): void;
    update(): void;
    data: any;
    options: any;
  };
};

declare const initSqlJs: (config?: { locateFile?: (file: string) => string }) => Promise<{
  Database: new (data?: ArrayLike<number>) => {
    exec(sql: string, params?: any[]): { columns: string[]; values: any[][] }[];
    close(): void;
  };
}>;

declare const Hammer: any;
