import { config } from "../config.js";
import type { OuraApiListResponse } from "./types.js";

const BASE_URL = "https://api.ouraring.com/v2/usercollection";

export class OuraClient {
  private readonly token: string;

  public constructor(token: string = config.oura.accessToken) {
    this.token = token;
  }

  private async fetchCollection<T>(
    endpoint: string,
    startDate: string,
    endDate: string
  ): Promise<T[]> {
    if (!this.token) return [];
    const url = new URL(`${BASE_URL}/${endpoint}`);
    url.searchParams.set("start_date", startDate);
    url.searchParams.set("end_date", endDate);

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Oura API ${endpoint} failed (${response.status}): ${errorBody}`);
    }

    const payload = (await response.json()) as OuraApiListResponse<T>;
    return payload.data ?? [];
  }

  public getDailySleep(startDate: string, endDate: string): Promise<Record<string, unknown>[]> {
    return this.fetchCollection("daily_sleep", startDate, endDate);
  }

  public getSleepSessions(startDate: string, endDate: string): Promise<Record<string, unknown>[]> {
    return this.fetchCollection("sleep", startDate, endDate);
  }

  public getDailyReadiness(startDate: string, endDate: string): Promise<Record<string, unknown>[]> {
    return this.fetchCollection("daily_readiness", startDate, endDate);
  }

  public getDailyActivity(startDate: string, endDate: string): Promise<Record<string, unknown>[]> {
    return this.fetchCollection("daily_activity", startDate, endDate);
  }

  public getDailyStress(startDate: string, endDate: string): Promise<Record<string, unknown>[]> {
    return this.fetchCollection("daily_stress", startDate, endDate);
  }

  public getWorkouts(startDate: string, endDate: string): Promise<Record<string, unknown>[]> {
    return this.fetchCollection("workout", startDate, endDate);
  }
}
