import { FactoryProvider } from "@nestjs/common";
import { Taxonomy } from "../../market/domain/taxonomy";
import { loadTaxonomy } from "../../market/infrastructure/taxonomy-loader";
import { Criteria } from "../../prefilter/domain/criteria";
import { loadCriteria } from "../../prefilter/infrastructure/criteria-loader";
import { Profile } from "../../profile/domain/profile";
import { loadProfile } from "../../profile/infrastructure/profile-loader";

/**
 * Loaded once, at module construction, not per request — `POST
 * /runs/deliver` is triggered on demand, but `docs/09-configuration.md`
 * rule 5 ("config is read once at startup, not per stage") applies to it
 * exactly as it applies to the scheduler's nightly trigger: a mid-run edit
 * to `criteria.yaml`/`profile.yaml` takes effect on the next container
 * restart, not on the next API call.
 */
export const CRITERIA = Symbol("CRITERIA");
export const PROFILE = Symbol("PROFILE");
export const TAXONOMY = Symbol("TAXONOMY");

export const criteriaProvider: FactoryProvider<Criteria> = {
  provide: CRITERIA,
  useFactory: (): Criteria =>
    loadCriteria(process.env.CRITERIA_PATH ?? "./config/criteria.yaml"),
};

export const profileProvider: FactoryProvider<Profile> = {
  provide: PROFILE,
  useFactory: (): Profile =>
    loadProfile(process.env.PROFILE_PATH ?? "./config/profile.yaml"),
};

export const taxonomyProvider: FactoryProvider<Taxonomy> = {
  provide: TAXONOMY,
  useFactory: (): Taxonomy =>
    loadTaxonomy(process.env.TAXONOMY_PATH ?? "./config/taxonomy.yaml"),
};
