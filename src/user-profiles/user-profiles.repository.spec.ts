import { UserProfilesRepository } from "./user-profiles.repository";

describe("UserProfilesRepository", () => {
  function createRepository() {
    return new UserProfilesRepository({} as any);
  }

  it("updates existing profile during upsert to avoid duplicates", async () => {
    const repository = createRepository();

    jest.spyOn(repository, "findByUserId").mockResolvedValue({ id: 1 } as any);
    const updateSpy = jest
      .spyOn(repository, "updateByUserId")
      .mockResolvedValue({ id: 1, userId: "u-1" } as any);
    const createSpy = jest
      .spyOn(repository, "createByUserId")
      .mockResolvedValue({ id: 2 } as any);

    const result = await repository.upsertByUserId("u-1", { displayName: "A" });

    expect(result.mode).toBe("updated");
    expect(updateSpy).toHaveBeenCalledWith("u-1", { displayName: "A" });
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("creates profile when user has no existing record", async () => {
    const repository = createRepository();

    jest.spyOn(repository, "findByUserId").mockResolvedValue(undefined);
    jest
      .spyOn(repository, "createByUserId")
      .mockResolvedValue({ id: 3, userId: "u-2" } as any);

    const result = await repository.upsertByUserId("u-2", {
      displayName: "User Two",
    });

    expect(result.mode).toBe("created");
  });

  it("recovers from unique race by switching to update", async () => {
    const repository = createRepository();

    jest.spyOn(repository, "findByUserId").mockResolvedValue(undefined);
    jest.spyOn(repository, "createByUserId").mockRejectedValue({ code: "23505" });
    const updateSpy = jest
      .spyOn(repository, "updateByUserId")
      .mockResolvedValue({ id: 4, userId: "u-3" } as any);

    const result = await repository.upsertByUserId("u-3", {
      displayName: "Recovered",
    });

    expect(result.mode).toBe("updated");
    expect(updateSpy).toHaveBeenCalled();
  });

  it("returns explicit no_profile for prompt-context reads", async () => {
    const repository = createRepository();
    jest.spyOn(repository, "findByUserId").mockResolvedValue(undefined);

    const result = await repository.getPromptContextProfile("u-9");

    expect(result).toEqual({ status: "no_profile" });
  });
});
