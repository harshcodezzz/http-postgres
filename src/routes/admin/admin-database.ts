import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import {
  listPostgresDatabases,
  getPostgresDatabaseDetails,
  createPostgresDatabase,
  alterPostgresDatabase,
  deletePostgresDatabase,
  DatabaseError,
} from "../../utils/pg-database.js";
import { withQueryPoolMaintenance } from "../query/index.js";

export interface CreateDatabaseBody {
  name?: string;
  database?: string;
  owner?: string;
  template?: string;
  encoding?: string;
  lcCollate?: string;
  lc_collate?: string;
  lcCtype?: string;
  lc_ctype?: string;
  tablespace?: string;
  connectionLimit?: number;
  connection_limit?: number;
}

export interface AlterDatabaseBody {
  newName?: string;
  name?: string;
  owner?: string;
  allowConnections?: unknown;
  allow_connections?: unknown;
  connectionLimit?: number;
  connection_limit?: number;
  settings?: Record<string, string>;
  resetSettings?: string[];
  reset_settings?: string[];
}

function mapDatabaseErrorStatus(code: string): number {
  switch (code) {
    case "DATABASE_NOT_FOUND":
      return 404;
    case "DATABASE_ALREADY_EXISTS":
    case "DATABASE_IN_USE":
      return 409;
    case "PROTECTED_DATABASE":
    case "INSUFFICIENT_PRIVILEGE":
      return 403;
    case "INVALID_PARAMETER_VALUE":
    case "INVALID_DATABASE_NAME":
    case "INVALID_REQUEST_BODY":
      return 400;
    case "PARTIAL_RENAME_METADATA_SYNC_FAILED":
    case "PARTIAL_DELETE_METADATA_SYNC_FAILED":
      return 500;
    default:
      return 400;
  }
}

function sendErrorReply(
  reply: FastifyReply,
  err: unknown,
  log: { error: (err: unknown, msg?: string) => void },
  logMessage: string,
  fallbackMessage: string,
) {
  if (err instanceof DatabaseError) {
    const statusCode = mapDatabaseErrorStatus(err.code);
    if (statusCode >= 500) {
      log.error(err, logMessage);
    }
    return reply.code(statusCode).send({
      success: false,
      error: {
        code: err.code,
        message: err.message,
      },
    });
  }

  log.error(err, logMessage);
  return reply.code(500).send({
    success: false,
    error: {
      code: "DATABASE_ERROR",
      message: fallbackMessage,
    },
  });
}

function getField(obj: Record<string, unknown>, camel: string, snake: string): unknown {
  if (camel in obj) return obj[camel];
  if (snake in obj) return obj[snake];
  return undefined;
}

function parseOptionalBoolean(value: unknown, fieldName: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (lower === "true" || lower === "1") return true;
    if (lower === "false" || lower === "0") return false;
  }
  throw new DatabaseError(`'${fieldName}' must be a boolean`, "INVALID_PARAMETER_VALUE");
}

function parseOptionalInteger(
  value: unknown,
  fieldName: string,
  min?: number,
): number | undefined {
  if (value === undefined) return undefined;
  let num: number;
  if (typeof value === "number") {
    num = value;
  } else if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    num = parseInt(value.trim(), 10);
  } else {
    throw new DatabaseError(`'${fieldName}' must be an integer`, "INVALID_PARAMETER_VALUE");
  }
  if (!Number.isInteger(num)) {
    throw new DatabaseError(`'${fieldName}' must be an integer`, "INVALID_PARAMETER_VALUE");
  }
  if (min !== undefined && num < min) {
    throw new DatabaseError(
      `'${fieldName}' must be an integer greater than or equal to ${min}`,
      "INVALID_PARAMETER_VALUE",
    );
  }
  return num;
}

function parseOptionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  throw new DatabaseError(`'${fieldName}' must be a string`, "INVALID_PARAMETER_VALUE");
}

function parseOptionalStringArray(value: unknown, fieldName: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value;
  }
  throw new DatabaseError(`'${fieldName}' must be an array of strings`, "INVALID_PARAMETER_VALUE");
}

function parseOptionalRecord(value: unknown, fieldName: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record: Record<string, string> = {};
    for (const [k, v] of Object.entries(value)) {
      if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
        throw new DatabaseError(
          `Values in '${fieldName}' must be strings`,
          "INVALID_PARAMETER_VALUE",
        );
      }
      record[k] = String(v);
    }
    return record;
  }
  throw new DatabaseError(`'${fieldName}' must be an object`, "INVALID_PARAMETER_VALUE");
}

const adminDatabaseRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/databases", async (_request, reply) => {
    try {
      const databases = await listPostgresDatabases(fastify.db);
      return {
        success: true,
        count: databases.length,
        databases,
      };
    } catch (err: unknown) {
      return sendErrorReply(
        reply,
        err,
        fastify.log,
        "Failed to list databases",
        "Failed to list databases",
      );
    }
  });

  fastify.get<{ Params: { name: string } }>(
    "/databases/:name",
    async (request, reply) => {
      const dbName = request.params.name;
      try {
        const details = await getPostgresDatabaseDetails(dbName, fastify.db);

        if (!details) {
          return reply.code(404).send({
            success: false,
            error: {
              code: "DATABASE_NOT_FOUND",
              message: `Database '${dbName}' not found`,
            },
          });
        }

        return {
          success: true,
          database: details,
        };
      } catch (err: unknown) {
        return sendErrorReply(
          reply,
          err,
          fastify.log,
          "Failed to retrieve database details",
          "Failed to retrieve database details",
        );
      }
    },
  );

  fastify.post<{ Body: Record<string, unknown> }>(
    "/databases",
    async (request, reply) => {
      const body = (request.body && typeof request.body === "object" ? request.body : {}) as Record<string, unknown>;
      const rawName = getField(body, "name", "database");

      if (rawName === undefined || rawName === null || typeof rawName !== "string" || rawName.trim() === "") {
        return reply.code(400).send({
          success: false,
          error: {
            code: "INVALID_DATABASE_NAME",
            message: "Database name is required in 'name' or 'database'",
          },
        });
      }

      try {
        const owner = parseOptionalString(getField(body, "owner", "owner"), "owner");
        const template = parseOptionalString(getField(body, "template", "template"), "template");
        const encoding = parseOptionalString(getField(body, "encoding", "encoding"), "encoding");
        const lcCollate = parseOptionalString(getField(body, "lcCollate", "lc_collate"), "lcCollate");
        const lcCtype = parseOptionalString(getField(body, "lcCtype", "lc_ctype"), "lcCtype");
        const tablespace = parseOptionalString(getField(body, "tablespace", "tablespace"), "tablespace");
        const connectionLimit = parseOptionalInteger(
          getField(body, "connectionLimit", "connection_limit"),
          "connectionLimit",
          -1,
        );

        await createPostgresDatabase(
          {
            name: rawName.trim(),
            owner,
            template,
            encoding,
            lcCollate,
            lcCtype,
            tablespace,
            connectionLimit,
          },
          fastify.db,
        );

        return reply.code(201).send({
          success: true,
          message: `Database '${rawName.trim()}' created successfully`,
          database: rawName.trim(),
        });
      } catch (err: unknown) {
        return sendErrorReply(
          reply,
          err,
          fastify.log,
          "Failed to create database",
          "Failed to create database",
        );
      }
    },
  );

  const alterHandler = async (
    request: FastifyRequest<{
      Params: { name: string };
      Body: Record<string, unknown>;
    }>,
    reply: FastifyReply,
  ) => {
    const dbName = request.params.name;
    const body = (request.body && typeof request.body === "object" ? request.body : {}) as Record<string, unknown>;

    try {
      const newName = parseOptionalString(getField(body, "newName", "name"), "newName");
      const owner = parseOptionalString(getField(body, "owner", "owner"), "owner");
      const allowConnections = parseOptionalBoolean(
        getField(body, "allowConnections", "allow_connections"),
        "allowConnections",
      );
      const connectionLimit = parseOptionalInteger(
        getField(body, "connectionLimit", "connection_limit"),
        "connectionLimit",
        -1,
      );
      const settings = parseOptionalRecord(getField(body, "settings", "settings"), "settings");
      const resetSettings = parseOptionalStringArray(
        getField(body, "resetSettings", "reset_settings"),
        "resetSettings",
      );

      const alter = () => alterPostgresDatabase(
        dbName,
        {
          newName,
          owner,
          allowConnections,
          connectionLimit,
          settings,
          resetSettings,
        },
        fastify.db,
        fastify.jsondb,
      );

      const result = newName && newName !== dbName
        ? await withQueryPoolMaintenance(dbName, alter)
        : await alter();

      const targetName = result.renamed ? result.database : dbName;

      return {
        success: true,
        message: `Database '${targetName}' properties updated successfully`,
        database: result.database,
        renamed: result.renamed,
      };
    } catch (err: unknown) {
      return sendErrorReply(
        reply,
        err,
        fastify.log,
        "Failed to alter database",
        "Failed to alter database",
      );
    }
  };

  fastify.patch<{
    Params: { name: string };
    Body: Record<string, unknown>;
  }>("/databases/:name", alterHandler);

  fastify.put<{
    Params: { name: string };
    Body: Record<string, unknown>;
  }>("/databases/:name", alterHandler);

  fastify.delete<{
    Params: { name: string };
    Querystring: { force?: unknown };
  }>("/databases/:name", async (request, reply) => {
    const dbName = request.params.name;
    const rawForce = request.query?.force;

    let isForce = false;
    if (rawForce !== undefined) {
      if (typeof rawForce === "boolean") {
        isForce = rawForce;
      } else if (typeof rawForce === "string") {
        const lower = rawForce.trim().toLowerCase();
        if (lower === "true" || lower === "1") {
          isForce = true;
        } else if (lower === "false" || lower === "0" || lower === "") {
          isForce = false;
        } else {
          return reply.code(400).send({
            success: false,
            error: {
              code: "INVALID_PARAMETER_VALUE",
              message: "Query parameter 'force' must be a boolean",
            },
          });
        }
      } else {
        return reply.code(400).send({
          success: false,
          error: {
            code: "INVALID_PARAMETER_VALUE",
            message: "Query parameter 'force' must be a boolean",
          },
        });
      }
    }

    try {
      await withQueryPoolMaintenance(
        dbName,
        () => deletePostgresDatabase(dbName, fastify.db, isForce, fastify.jsondb),
        isForce,
      );
      return {
        success: true,
        message: `Database '${dbName}' deleted successfully`,
      };
    } catch (err: unknown) {
      return sendErrorReply(
        reply,
        err,
        fastify.log,
        "Failed to delete database",
        "Failed to delete database",
      );
    }
  });
};

export default adminDatabaseRoutes;
