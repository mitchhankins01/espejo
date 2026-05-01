import { config } from "../config.js";
import type { OuraApiListResponse } from "./types.js";

const BASE_URL = "https://api.ouraring.com/v2/usercollection";
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const RETRYABLE_STATUSES = new Set([502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function addDays(dateStr: string, days: number): string {
  const date = new Date(`${dateStr}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().split("T")[0];
}

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
    const MAX_PAGES = 200;
    const all: T[] = [];
    let nextToken: string | undefined;
    let page = 0;

    do {
      const url = new URL(`${BASE_URL}/${endpoint}`);
      url.searchParams.set("start_date", startDate);
      url.searchParams.set("end_date", endDate);
      if (nextToken) url.searchParams.set("next_token", nextToken);

      let response: Response | undefined;
      for (let attempt = 0; ; attempt++) {
        response = await fetch(url, {
          headers: { Authorization: `Bearer ${this.token}` },
        });
        if (response.ok || !RETRYABLE_STATUSES.has(response.status) || attempt >= MAX_RETRIES) break;
        await sleep(BASE_DELAY_MS * 2 ** attempt);
      }

      if (!response!.ok) {
        const errorBody = await response!.text();
        throw new Error(`Oura API ${endpoint} failed (${response!.status}): ${errorBody}`);
      }

      const payload = (await response!.json()) as OuraApiListResponse<T>;
      all.push(...(payload.data ?? []));
      nextToken = payload.next_token ?? undefined;
      page++;
    } while (nextToken && page < MAX_PAGES);

    return all;
  }

  public getDailySleep(startDate: string, endDate: string): Promise<Record<string, unknown>[]> {
    return this.fetchCollection("daily_sleep", startDate, endDate);
  }

  public async getSleepSessions(startDate: string, endDate: string): Promise<Record<string, unknown>[]> {
    if (startDate === endDate) {
      const expanded = await this.fetchCollection<Record<string, unknown>>(
        "sleep",
        addDays(startDate, -1),
        addDays(endDate, 1)
      );
      return expanded.filter((item) => {
        const day = item.day as string | undefined;
        return day != null && day >= startDate && day <= endDate;
      });
    }
    return this.fetchCollection("sleep", startDate, endDate);
  }

  public getDailyReadiness(startDate: string, endDate: string): Promise<Record<string, unknown>[]> {
    return this.fetchCollection("daily_readiness", startDate, endDate);
  }

  public async getDailyActivity(startDate: string, endDate: string): Promise<Record<string, unknown>[]> {
    if (startDate === endDate) {
      const expanded = await this.fetchCollection<Record<string, unknown>>(
        "daily_activity",
        addDays(startDate, -1),
        addDays(endDate, 1)
      );
      return expanded.filter((item) => {
        const day = item.day as string | undefined;
        return day != null && day >= startDate && day <= endDate;
      });
    }
    return this.fetchCollection("daily_activity", startDate, endDate);
  }

  public getDailyStress(startDate: string, endDate: string): Promise<Record<string, unknown>[]> {
    return this.fetchCollection("daily_stress", startDate, endDate);
  }

  public async getWorkouts(startDate: string, endDate: string): Promise<Record<string, unknown>[]> {
    if (startDate === endDate) {
      const expanded = await this.fetchCollection<Record<string, unknown>>(
        "workout",
        addDays(startDate, -1),
        addDays(endDate, 1)
      );
      return expanded.filter((item) => {
        const day = item.day as string | undefined;
        return day != null && day >= startDate && day <= endDate;
      });
    }
    return this.fetchCollection("workout", startDate, endDate);
  }

  // personal_info is a non-collection singleton — different shape from the others.
  public async getPersonalInfo(): Promise<Record<string, unknown> | null> {
    if (!this.token) return null;
    const url = `${BASE_URL}/personal_info`;
    let response: Response | undefined;
    for (let attempt = 0; ; attempt++) {
      response = await fetch(url, { headers: { Authorization: `Bearer ${this.token}` } });
      if (response.ok || !RETRYABLE_STATUSES.has(response.status) || attempt >= MAX_RETRIES) break;
      await sleep(BASE_DELAY_MS * 2 ** attempt);
    }
    if (!response!.ok) {
      const errorBody = await response!.text();
      throw new Error(`Oura API personal_info failed (${response!.status}): ${errorBody}`);
    }
    return (await response!.json()) as Record<string, unknown>;
  }

  public getRingConfigurations(startDate: string, endDate: string): Promise<Record<string, unknown>[]> {
    return this.fetchCollection("ring_configuration", startDate, endDate);
  }

  public getDailySpo2(startDate: string, endDate: string): Promise<Record<string, unknown>[]> {
    return this.fetchCollection("daily_spo2", startDate, endDate);
  }

  public getDailyResilience(startDate: string, endDate: string): Promise<Record<string, unknown>[]> {
    return this.fetchCollection("daily_resilience", startDate, endDate);
  }

  public getDailyCardiovascularAge(startDate: string, endDate: string): Promise<Record<string, unknown>[]> {
    return this.fetchCollection("daily_cardiovascular_age", startDate, endDate);
  }

  public getSleepTime(startDate: string, endDate: string): Promise<Record<string, unknown>[]> {
    return this.fetchCollection("sleep_time", startDate, endDate);
  }

  public getEnhancedTags(startDate: string, endDate: string): Promise<Record<string, unknown>[]> {
    return this.fetchCollection("enhanced_tag", startDate, endDate);
  }

  public getRestModePeriods(startDate: string, endDate: string): Promise<Record<string, unknown>[]> {
    return this.fetchCollection("rest_mode_period", startDate, endDate);
  }

  public getSessions(startDate: string, endDate: string): Promise<Record<string, unknown>[]> {
    return this.fetchCollection("session", startDate, endDate);
  }

  // Heartrate uses datetime params, not date — paginate per chunk caller passes.
  public async getHeartrate(startDatetime: string, endDatetime: string): Promise<Record<string, unknown>[]> {
    if (!this.token) return [];
    const MAX_PAGES = 500;
    const all: Record<string, unknown>[] = [];
    let nextToken: string | undefined;
    let page = 0;

    do {
      const url = new URL(`${BASE_URL}/heartrate`);
      url.searchParams.set("start_datetime", startDatetime);
      url.searchParams.set("end_datetime", endDatetime);
      if (nextToken) url.searchParams.set("next_token", nextToken);

      let response: Response | undefined;
      for (let attempt = 0; ; attempt++) {
        response = await fetch(url, {
          headers: { Authorization: `Bearer ${this.token}` },
        });
        if (response.ok || !RETRYABLE_STATUSES.has(response.status) || attempt >= MAX_RETRIES) break;
        await sleep(BASE_DELAY_MS * 2 ** attempt);
      }

      if (!response!.ok) {
        const errorBody = await response!.text();
        throw new Error(`Oura API heartrate failed (${response!.status}): ${errorBody}`);
      }

      const payload = (await response!.json()) as OuraApiListResponse<Record<string, unknown>>;
      all.push(...(payload.data ?? []));
      nextToken = payload.next_token ?? undefined;
      page++;
    } while (nextToken && page < MAX_PAGES);

    return all;
  }
}
