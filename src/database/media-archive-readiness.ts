import { Logger } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { NodePgDatabase } from "drizzle-orm/node-postgres";

export const MEDIA_ARCHIVE_TABLE_NAME = "user_media";
export const MEDIA_ARCHIVE_REQUIRED_COLUMNS = [
  "archive_group_id",
  "archive_topic_id",
  "archive_message_id",
] as const;

const MEDIA_ARCHIVE_REMEDIATION =
  "Apply the latest Drizzle migrations to the target database before enabling media archive processing.";

type LoggerLike = Pick<Logger, "log" | "warn" | "error">;

export class MediaArchiveReadinessError extends Error {
  readonly code = "MEDIA_ARCHIVE_SCHEMA_MISMATCH";
  readonly tableName = MEDIA_ARCHIVE_TABLE_NAME;
  readonly missingColumns: string[];
  readonly remediation = MEDIA_ARCHIVE_REMEDIATION;

  constructor(missingColumns: string[]) {
    const uniqueColumns = Array.from(new Set(missingColumns));
    super(
      `Missing required archive columns on ${MEDIA_ARCHIVE_TABLE_NAME}: ${uniqueColumns.join(", ")}`,
    );
    this.name = "MediaArchiveReadinessError";
    this.missingColumns = uniqueColumns;
  }
}

export class MediaArchiveConnectivityError extends Error {
  readonly code = "MEDIA_ARCHIVE_DB_CONNECTIVITY";
  readonly remediation =
    "Verify DB_URL/network connectivity and rerun readiness checks.";

  constructor(cause: unknown) {
    super(
      "Database connectivity check failed while validating media archive schema.",
    );
    this.name = "MediaArchiveConnectivityError";
    this.cause = cause;
  }
}

export async function inspectMediaArchiveSchemaReadiness(
  db: NodePgDatabase<any>,
) {
  const result = (await db.execute(sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = ${MEDIA_ARCHIVE_TABLE_NAME}
      AND column_name IN ('archive_group_id', 'archive_topic_id', 'archive_message_id')
  `)) as { rows?: Array<{ column_name?: string | null }> };

  const discoveredColumns = new Set(
    (result.rows ?? [])
      .map((row) => row?.column_name)
      .filter((value): value is string => typeof value === "string"),
  );

  const missingColumns = MEDIA_ARCHIVE_REQUIRED_COLUMNS.filter(
    (column) => !discoveredColumns.has(column),
  );

  return {
    ready: missingColumns.length === 0,
    tableName: MEDIA_ARCHIVE_TABLE_NAME,
    missingColumns,
  };
}

export async function assertMediaArchiveSchemaReadiness(params: {
  db: NodePgDatabase<any>;
  logger: LoggerLike;
  source: "startup" | "runtime" | "migration";
}) {
  try {
    const readiness = await inspectMediaArchiveSchemaReadiness(params.db);
    if (!readiness.ready) {
      logMediaArchiveSchemaMismatch(params.logger, {
        source: params.source,
        missingColumns: readiness.missingColumns,
      });
      throw new MediaArchiveReadinessError(readiness.missingColumns);
    }
  } catch (error) {
    if (error instanceof MediaArchiveReadinessError) {
      throw error;
    }

    if (isDatabaseConnectivityIssue(error)) {
      logMediaArchiveConnectivityFailure(params.logger, {
        source: params.source,
        error,
      });
      throw new MediaArchiveConnectivityError(error);
    }

    throw error;
  }
}

export function extractArchiveColumnsFromDbError(error: unknown) {
  const code =
    typeof error === "object" && error
      ? ((error as { code?: unknown }).code as string | undefined)
      : undefined;
  const message = [
    typeof error === "object" && error
      ? ((error as { message?: unknown }).message as string | undefined)
      : undefined,
    typeof error === "object" && error
      ? ((error as { detail?: unknown }).detail as string | undefined)
      : undefined,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();

  if (code === "42703") {
    const matched = MEDIA_ARCHIVE_REQUIRED_COLUMNS.filter((column) =>
      message.includes(column),
    );
    if (matched.length > 0) return matched;
    return [...MEDIA_ARCHIVE_REQUIRED_COLUMNS];
  }

  if (code === "42P01" && message.includes(MEDIA_ARCHIVE_TABLE_NAME)) {
    return [...MEDIA_ARCHIVE_REQUIRED_COLUMNS];
  }

  return [];
}

export function logMediaArchiveSchemaMismatch(
  logger: LoggerLike,
  params: {
    source: "startup" | "runtime" | "migration";
    missingColumns: string[];
  },
) {
  logger.error(
    JSON.stringify({
      event: "media_archive.schema_readiness.mismatch",
      source: params.source,
      table: MEDIA_ARCHIVE_TABLE_NAME,
      missingColumns: params.missingColumns,
      remediation: MEDIA_ARCHIVE_REMEDIATION,
    }),
  );
}

function logMediaArchiveConnectivityFailure(
  logger: LoggerLike,
  params: {
    source: "startup" | "runtime" | "migration";
    error: unknown;
  },
) {
  logger.error(
    JSON.stringify({
      event: "media_archive.schema_readiness.connectivity_failed",
      source: params.source,
      table: MEDIA_ARCHIVE_TABLE_NAME,
      remediation:
        "Check DB_URL, network access, and database availability before retrying startup.",
      errorMessage: extractErrorMessage(params.error),
    }),
  );
}

function isDatabaseConnectivityIssue(error: unknown) {
  const code =
    typeof error === "object" && error
      ? ((error as { code?: unknown }).code as string | undefined)
      : undefined;
  if (
    code &&
    [
      "ECONNREFUSED",
      "ECONNRESET",
      "ETIMEDOUT",
      "EHOSTUNREACH",
      "ENOTFOUND",
      "08001",
      "08006",
      "57P01",
    ].includes(code)
  ) {
    return true;
  }

  const message = extractErrorMessage(error).toLowerCase();
  return (
    message.includes("connect") ||
    message.includes("connection") ||
    message.includes("timeout")
  );
}

function extractErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (typeof error === "object" && error) {
    const value = (error as { message?: unknown }).message;
    if (typeof value === "string") {
      return value;
    }
  }
  return "Unknown error";
}
