import sql from "mssql";

let poolPromise: Promise<sql.ConnectionPool> | undefined;

export function getDbConfig(): sql.config {
  return {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER || "",
    database: process.env.DB_NAME,
    options: {
      encrypt: true,
      trustServerCertificate: false,
    },
  };
}

export async function getDbPool(): Promise<sql.ConnectionPool> {
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool(getDbConfig()).connect();
  }

  return poolPromise;
}

