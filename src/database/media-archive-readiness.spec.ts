import {
  assertMediaArchiveSchemaReadiness,
  extractArchiveColumnsFromDbError,
  MediaArchiveConnectivityError,
  MediaArchiveReadinessError,
  inspectMediaArchiveSchemaReadiness,
} from "./media-archive-readiness";

describe("media-archive-readiness", () => {
  function createLogger() {
    return {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
  }

  it("detects schema-ready archive columns", async () => {
    const db: any = {
      execute: jest.fn().mockResolvedValue({
        rows: [
          { column_name: "archive_group_id" },
          { column_name: "archive_topic_id" },
          { column_name: "archive_message_id" },
        ],
      }),
    };

    const readiness = await inspectMediaArchiveSchemaReadiness(db);

    expect(readiness.ready).toBe(true);
    expect(readiness.missingColumns).toEqual([]);
  });

  it("throws readiness error with structured mismatch log", async () => {
    const db: any = {
      execute: jest.fn().mockResolvedValue({
        rows: [{ column_name: "archive_group_id" }],
      }),
    };
    const logger = createLogger();

    await expect(
      assertMediaArchiveSchemaReadiness({
        db,
        logger,
        source: "startup",
      }),
    ).rejects.toBeInstanceOf(MediaArchiveReadinessError);

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining(
        '"event":"media_archive.schema_readiness.mismatch"',
      ),
    );
  });

  it("maps connectivity failure into explicit connectivity error", async () => {
    const db: any = {
      execute: jest.fn().mockRejectedValue({
        code: "ECONNREFUSED",
        message: "connect ECONNREFUSED 127.0.0.1:5432",
      }),
    };
    const logger = createLogger();

    await expect(
      assertMediaArchiveSchemaReadiness({
        db,
        logger,
        source: "runtime",
      }),
    ).rejects.toBeInstanceOf(MediaArchiveConnectivityError);

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining(
        '"event":"media_archive.schema_readiness.connectivity_failed"',
      ),
    );
  });

  it("extracts missing archive columns from postgres undefined-column error", () => {
    const missing = extractArchiveColumnsFromDbError({
      code: "42703",
      message:
        'column "archive_topic_id" of relation "user_media" does not exist',
    });

    expect(missing).toEqual(["archive_topic_id"]);
  });
});
