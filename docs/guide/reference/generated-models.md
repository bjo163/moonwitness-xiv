# Generated model and addon reference

Source fingerprint: `da8be776f3934efefa4a52d6b55262e249829b7fe90d250201757c071eaf7198`. Seed values and field defaults are intentionally omitted.

## Addon `auth`

Version: `1.0.0`; dependencies: `base`.

Models: 1; declared views: 0; menu entries: 0; seed rows: 0.

| Model                | Table                 | Field                  | Kind      | Required | Optional | Default    | Relation    |
| -------------------- | --------------------- | ---------------------- | --------- | -------- | -------- | ---------- | ----------- |
| `auth.refresh_token` | `auth_refresh_tokens` | `expires_at`           | string    | Yes      | No       | No         | —           |
| `auth.refresh_token` | `auth_refresh_tokens` | `family`               | string    | Yes      | No       | No         | —           |
| `auth.refresh_token` | `auth_refresh_tokens` | `revoked`              | boolean   | No       | Yes      | [redacted] | —           |
| `auth.refresh_token` | `auth_refresh_tokens` | `rotated_at`           | string    | No       | Yes      | No         | —           |
| `auth.refresh_token` | `auth_refresh_tokens` | `rotation_lease_until` | string    | No       | Yes      | No         | —           |
| `auth.refresh_token` | `auth_refresh_tokens` | `token_hash`           | string    | Yes      | No       | No         | —           |
| `auth.refresh_token` | `auth_refresh_tokens` | `user`                 | belongsTo | Yes      | No       | No         | `base.user` |
| `auth.refresh_token` | `auth_refresh_tokens` | `user_agent`           | string    | No       | Yes      | No         | —           |

### Menus and seed coverage

| Menu model | Label | Group | Sequence | Visibility |
| ---------- | ----- | ----- | -------: | ---------- |

## Addon `base`

Version: `1.0.0`; dependencies: none.

Models: 22; declared views: 22; menu entries: 22; seed rows: 736.

| Model                        | Table                    | Field                  | Kind      | Required | Optional | Default    | Relation                |
| ---------------------------- | ------------------------ | ---------------------- | --------- | -------- | -------- | ---------- | ----------------------- |
| `base.access_group`          | `access_groups`          | `code`                 | string    | Yes      | No       | No         | —                       |
| `base.access_group`          | `access_groups`          | `description`          | text      | No       | Yes      | No         | —                       |
| `base.access_group`          | `access_groups`          | `name`                 | string    | Yes      | No       | No         | —                       |
| `base.activity`              | `activities`             | `activity_type`        | enum      | No       | Yes      | [redacted] | —                       |
| `base.activity`              | `activities`             | `assigned_to`          | belongsTo | No       | Yes      | No         | `base.user`             |
| `base.activity`              | `activities`             | `deadline`             | string    | No       | Yes      | No         | —                       |
| `base.activity`              | `activities`             | `note`                 | text      | No       | Yes      | No         | —                       |
| `base.activity`              | `activities`             | `resource_id`          | integer   | Yes      | No       | No         | —                       |
| `base.activity`              | `activities`             | `resource_model`       | string    | Yes      | No       | No         | —                       |
| `base.activity`              | `activities`             | `state`                | enum      | No       | Yes      | [redacted] | —                       |
| `base.activity`              | `activities`             | `summary`              | string    | Yes      | No       | No         | —                       |
| `base.attachment`            | `attachments`            | `checksum`             | string    | No       | Yes      | No         | —                       |
| `base.attachment`            | `attachments`            | `mimetype`             | string    | Yes      | No       | No         | —                       |
| `base.attachment`            | `attachments`            | `name`                 | string    | Yes      | No       | No         | —                       |
| `base.attachment`            | `attachments`            | `resource_id`          | integer   | Yes      | No       | No         | —                       |
| `base.attachment`            | `attachments`            | `resource_model`       | string    | Yes      | No       | No         | —                       |
| `base.attachment`            | `attachments`            | `size_bytes`           | integer   | Yes      | No       | No         | —                       |
| `base.attachment`            | `attachments`            | `storage_key`          | string    | Yes      | No       | No         | —                       |
| `base.audit_log`             | `audit_logs`             | `actor_id`             | integer   | No       | Yes      | No         | —                       |
| `base.audit_log`             | `audit_logs`             | `changes`              | text      | Yes      | No       | No         | —                       |
| `base.audit_log`             | `audit_logs`             | `model`                | string    | Yes      | No       | No         | —                       |
| `base.audit_log`             | `audit_logs`             | `operation`            | string    | Yes      | No       | No         | —                       |
| `base.audit_log`             | `audit_logs`             | `record_id`            | integer   | Yes      | No       | No         | —                       |
| `base.bank`                  | `banks`                  | `bic`                  | string    | No       | Yes      | No         | —                       |
| `base.bank`                  | `banks`                  | `code`                 | string    | No       | Yes      | No         | —                       |
| `base.bank`                  | `banks`                  | `country`              | belongsTo | No       | Yes      | No         | `base.country`          |
| `base.bank`                  | `banks`                  | `name`                 | string    | Yes      | No       | No         | —                       |
| `base.bank`                  | `banks`                  | `phone`                | string    | No       | Yes      | No         | —                       |
| `base.bank`                  | `banks`                  | `website`              | string    | No       | Yes      | No         | —                       |
| `base.company`               | `companies`              | `city`                 | string    | No       | Yes      | No         | —                       |
| `base.company`               | `companies`              | `country`              | belongsTo | No       | Yes      | No         | `base.country`          |
| `base.company`               | `companies`              | `currency`             | belongsTo | No       | Yes      | No         | `base.currency`         |
| `base.company`               | `companies`              | `email`                | string    | No       | Yes      | No         | —                       |
| `base.company`               | `companies`              | `language`             | belongsTo | No       | Yes      | No         | `base.language`         |
| `base.company`               | `companies`              | `name`                 | string    | Yes      | No       | No         | —                       |
| `base.company`               | `companies`              | `phone`                | string    | No       | Yes      | No         | —                       |
| `base.company`               | `companies`              | `postal_code`          | string    | No       | Yes      | No         | —                       |
| `base.company`               | `companies`              | `street`               | string    | No       | Yes      | No         | —                       |
| `base.company`               | `companies`              | `timezone`             | string    | No       | Yes      | [redacted] | —                       |
| `base.company`               | `companies`              | `website`              | string    | No       | Yes      | No         | —                       |
| `base.company_membership`    | `company_memberships`    | `company`              | belongsTo | Yes      | No       | No         | `base.company`          |
| `base.company_membership`    | `company_memberships`    | `is_default`           | boolean   | No       | Yes      | [redacted] | —                       |
| `base.company_membership`    | `company_memberships`    | `user`                 | belongsTo | Yes      | No       | No         | `base.user`             |
| `base.country`               | `countries`              | `code`                 | string    | Yes      | No       | No         | —                       |
| `base.country`               | `countries`              | `code_alpha3`          | string    | No       | Yes      | No         | —                       |
| `base.country`               | `countries`              | `name`                 | string    | Yes      | No       | No         | —                       |
| `base.country`               | `countries`              | `phone_code`           | string    | No       | Yes      | No         | —                       |
| `base.country`               | `countries`              | `vat_label`            | string    | No       | Yes      | No         | —                       |
| `base.country_state`         | `country_states`         | `code`                 | string    | Yes      | No       | No         | —                       |
| `base.country_state`         | `country_states`         | `country`              | belongsTo | Yes      | No       | No         | `base.country`          |
| `base.country_state`         | `country_states`         | `name`                 | string    | Yes      | No       | No         | —                       |
| `base.country_state`         | `country_states`         | `type`                 | string    | No       | Yes      | No         | —                       |
| `base.currency`              | `currencies`             | `code`                 | string    | Yes      | No       | No         | —                       |
| `base.currency`              | `currencies`             | `name`                 | string    | Yes      | No       | No         | —                       |
| `base.currency`              | `currencies`             | `symbol`               | string    | No       | Yes      | No         | —                       |
| `base.group_membership`      | `group_memberships`      | `group`                | belongsTo | Yes      | No       | No         | `base.access_group`     |
| `base.group_membership`      | `group_memberships`      | `user`                 | belongsTo | Yes      | No       | No         | `base.user`             |
| `base.language`              | `languages`              | `code`                 | string    | Yes      | No       | No         | —                       |
| `base.language`              | `languages`              | `name`                 | string    | Yes      | No       | No         | —                       |
| `base.model_access`          | `model_access`           | `create`               | boolean   | No       | Yes      | [redacted] | —                       |
| `base.model_access`          | `model_access`           | `group`                | belongsTo | Yes      | No       | No         | `base.access_group`     |
| `base.model_access`          | `model_access`           | `model_name`           | string    | Yes      | No       | No         | —                       |
| `base.model_access`          | `model_access`           | `read`                 | boolean   | No       | Yes      | [redacted] | —                       |
| `base.model_access`          | `model_access`           | `unlink`               | boolean   | No       | Yes      | [redacted] | —                       |
| `base.model_access`          | `model_access`           | `write`                | boolean   | No       | Yes      | [redacted] | —                       |
| `base.partner`               | `partners`               | `addresses`            | hasMany   | No       | Yes      | No         | `base.partner_address`  |
| `base.partner`               | `partners`               | `city`                 | string    | No       | Yes      | No         | —                       |
| `base.partner`               | `partners`               | `company`              | belongsTo | No       | Yes      | No         | `base.company`          |
| `base.partner`               | `partners`               | `country`              | belongsTo | No       | Yes      | No         | `base.country`          |
| `base.partner`               | `partners`               | `email`                | string    | No       | Yes      | No         | —                       |
| `base.partner`               | `partners`               | `is_company`           | boolean   | No       | Yes      | [redacted] | —                       |
| `base.partner`               | `partners`               | `is_customer`          | boolean   | No       | Yes      | [redacted] | —                       |
| `base.partner`               | `partners`               | `is_supplier`          | boolean   | No       | Yes      | [redacted] | —                       |
| `base.partner`               | `partners`               | `job_title`            | string    | No       | Yes      | No         | —                       |
| `base.partner`               | `partners`               | `mobile`               | string    | No       | Yes      | No         | —                       |
| `base.partner`               | `partners`               | `name`                 | string    | Yes      | No       | No         | —                       |
| `base.partner`               | `partners`               | `notes`                | text      | No       | Yes      | No         | —                       |
| `base.partner`               | `partners`               | `parent`               | belongsTo | No       | Yes      | No         | `base.partner`          |
| `base.partner`               | `partners`               | `phone`                | string    | No       | Yes      | No         | —                       |
| `base.partner`               | `partners`               | `postal_code`          | string    | No       | Yes      | No         | —                       |
| `base.partner`               | `partners`               | `state`                | belongsTo | No       | Yes      | No         | `base.country_state`    |
| `base.partner`               | `partners`               | `street`               | string    | No       | Yes      | No         | —                       |
| `base.partner`               | `partners`               | `vat`                  | string    | No       | Yes      | No         | —                       |
| `base.partner`               | `partners`               | `website`              | string    | No       | Yes      | No         | —                       |
| `base.partner_address`       | `partner_addresses`      | `address_type`         | enum      | No       | Yes      | [redacted] | —                       |
| `base.partner_address`       | `partner_addresses`      | `city`                 | string    | Yes      | No       | No         | —                       |
| `base.partner_address`       | `partner_addresses`      | `country`              | belongsTo | No       | Yes      | No         | `base.country`          |
| `base.partner_address`       | `partner_addresses`      | `is_primary`           | boolean   | No       | Yes      | [redacted] | —                       |
| `base.partner_address`       | `partner_addresses`      | `label`                | string    | Yes      | No       | No         | —                       |
| `base.partner_address`       | `partner_addresses`      | `partner`              | belongsTo | Yes      | No       | No         | `base.partner`          |
| `base.partner_address`       | `partner_addresses`      | `postal_code`          | string    | No       | Yes      | No         | —                       |
| `base.partner_address`       | `partner_addresses`      | `state`                | belongsTo | No       | Yes      | No         | `base.country_state`    |
| `base.partner_address`       | `partner_addresses`      | `street`               | string    | Yes      | No       | No         | —                       |
| `base.partner_address`       | `partner_addresses`      | `street2`              | string    | No       | Yes      | No         | —                       |
| `base.partner_bank`          | `partner_banks`          | `acc_holder_name`      | string    | No       | Yes      | No         | —                       |
| `base.partner_bank`          | `partner_banks`          | `acc_number`           | string    | Yes      | No       | No         | —                       |
| `base.partner_bank`          | `partner_banks`          | `bank`                 | belongsTo | No       | Yes      | No         | `base.bank`             |
| `base.partner_bank`          | `partner_banks`          | `company`              | belongsTo | No       | Yes      | No         | `base.company`          |
| `base.partner_bank`          | `partner_banks`          | `currency`             | belongsTo | No       | Yes      | No         | `base.currency`         |
| `base.partner_bank`          | `partner_banks`          | `is_primary`           | boolean   | No       | Yes      | [redacted] | —                       |
| `base.partner_bank`          | `partner_banks`          | `partner`              | belongsTo | Yes      | No       | No         | `base.partner`          |
| `base.partner_bank`          | `partner_banks`          | `sanitized_acc_number` | string    | No       | Yes      | No         | —                       |
| `base.partner_category`      | `partner_categories`     | `code`                 | string    | Yes      | No       | No         | —                       |
| `base.partner_category`      | `partner_categories`     | `color`                | string    | No       | Yes      | [redacted] | —                       |
| `base.partner_category`      | `partner_categories`     | `description`          | text      | No       | Yes      | No         | —                       |
| `base.partner_category`      | `partner_categories`     | `name`                 | string    | Yes      | No       | No         | —                       |
| `base.partner_category_link` | `partner_category_links` | `category`             | belongsTo | Yes      | No       | No         | `base.partner_category` |
| `base.partner_category_link` | `partner_category_links` | `partner`              | belongsTo | Yes      | No       | No         | `base.partner`          |
| `base.sequence`              | `sequences`              | `code`                 | string    | Yes      | No       | No         | —                       |
| `base.sequence`              | `sequences`              | `name`                 | string    | No       | Yes      | No         | —                       |
| `base.sequence`              | `sequences`              | `next_number`          | integer   | No       | Yes      | [redacted] | —                       |
| `base.sequence`              | `sequences`              | `padding`              | integer   | No       | Yes      | [redacted] | —                       |
| `base.sequence`              | `sequences`              | `prefix`               | string    | No       | Yes      | [redacted] | —                       |
| `base.tag`                   | `tags`                   | `color`                | string    | No       | Yes      | [redacted] | —                       |
| `base.tag`                   | `tags`                   | `description`          | text      | No       | Yes      | No         | —                       |
| `base.tag`                   | `tags`                   | `name`                 | string    | Yes      | No       | No         | —                       |
| `base.tag_link`              | `tag_links`              | `resource_id`          | integer   | Yes      | No       | No         | —                       |
| `base.tag_link`              | `tag_links`              | `resource_model`       | string    | Yes      | No       | No         | —                       |
| `base.tag_link`              | `tag_links`              | `tag`                  | belongsTo | Yes      | No       | No         | `base.tag`              |
| `base.user`                  | `users`                  | `language`             | belongsTo | No       | Yes      | No         | `base.language`         |
| `base.user`                  | `users`                  | `login`                | string    | Yes      | No       | No         | —                       |
| `base.user`                  | `users`                  | `partner`              | belongsTo | Yes      | No       | No         | `base.partner`          |
| `base.user`                  | `users`                  | `password`             | password  | No       | Yes      | No         | —                       |
| `base.user`                  | `users`                  | `role`                 | enum      | No       | Yes      | [redacted] | —                       |
| `base.user`                  | `users`                  | `timezone`             | string    | No       | Yes      | No         | —                       |

### Menus and seed coverage

| Menu model                   | Label                      | Group        | Sequence | Visibility       |
| ---------------------------- | -------------------------- | ------------ | -------: | ---------------- |
| `base.access_group`          | base.access_group          | Technical    |      420 | Development mode |
| `base.activity`              | Activities                 | Workspace    |       40 | Standard         |
| `base.attachment`            | Attachments                | Workspace    |       50 | Standard         |
| `base.audit_log`             | base.audit_log             | Technical    |      460 | Development mode |
| `base.bank`                  | base.bank                  | Finance      |      310 | Development mode |
| `base.company`               | Companies                  | Organization |       20 | Standard         |
| `base.company_membership`    | base.company_membership    | Technical    |      450 | Development mode |
| `base.country`               | base.country               | Localization |      210 | Development mode |
| `base.country_state`         | base.country_state         | Localization |      220 | Development mode |
| `base.currency`              | base.currency              | Localization |      230 | Development mode |
| `base.group_membership`      | base.group_membership      | Technical    |      430 | Development mode |
| `base.language`              | base.language              | Localization |      240 | Development mode |
| `base.model_access`          | base.model_access          | Technical    |      440 | Development mode |
| `base.partner`               | Partners                   | Workspace    |       10 | Standard         |
| `base.partner_address`       | base.partner_address       | Contacts     |      110 | Development mode |
| `base.partner_bank`          | base.partner_bank          | Finance      |      320 | Development mode |
| `base.partner_category`      | base.partner_category      | Contacts     |      120 | Development mode |
| `base.partner_category_link` | base.partner_category_link | Contacts     |      130 | Development mode |
| `base.sequence`              | base.sequence              | Technical    |      410 | Development mode |
| `base.tag`                   | Tags                       | Workspace    |       60 | Standard         |
| `base.tag_link`              | base.tag_link              | Technical    |      390 | Development mode |
| `base.user`                  | Users                      | Organization |       30 | Standard         |

- Seed coverage: `base.access_group` has 3 declared seed row(s); seed values are not included.
- Seed coverage: `base.activity` has 1 declared seed row(s); seed values are not included.
- Seed coverage: `base.attachment` has 1 declared seed row(s); seed values are not included.
- Seed coverage: `base.bank` has 8 declared seed row(s); seed values are not included.
- Seed coverage: `base.company` has 1 declared seed row(s); seed values are not included.
- Seed coverage: `base.company_membership` has 2 declared seed row(s); seed values are not included.
- Seed coverage: `base.country` has 249 declared seed row(s); seed values are not included.
- Seed coverage: `base.country_state` has 444 declared seed row(s); seed values are not included.
- Seed coverage: `base.currency` has 1 declared seed row(s); seed values are not included.
- Seed coverage: `base.group_membership` has 1 declared seed row(s); seed values are not included.
- Seed coverage: `base.language` has 1 declared seed row(s); seed values are not included.
- Seed coverage: `base.model_access` has 1 declared seed row(s); seed values are not included.
- Seed coverage: `base.partner` has 10 declared seed row(s); seed values are not included.
- Seed coverage: `base.partner_address` has 1 declared seed row(s); seed values are not included.
- Seed coverage: `base.partner_bank` has 2 declared seed row(s); seed values are not included.
- Seed coverage: `base.partner_category` has 2 declared seed row(s); seed values are not included.
- Seed coverage: `base.partner_category_link` has 2 declared seed row(s); seed values are not included.
- Seed coverage: `base.sequence` has 2 declared seed row(s); seed values are not included.
- Seed coverage: `base.tag` has 1 declared seed row(s); seed values are not included.
- Seed coverage: `base.tag_link` has 1 declared seed row(s); seed values are not included.
- Seed coverage: `base.user` has 2 declared seed row(s); seed values are not included.

### Seeded model access rules

| Group reference   | Model          | Read | Create | Write | Delete |
| ----------------- | -------------- | ---- | ------ | ----- | ------ |
| `base.group_user` | `base.partner` | Yes  | No     | No    | No     |

## Addon `jobs`

Version: `1.0.0`; dependencies: `base`.

Models: 4; declared views: 0; menu entries: 0; seed rows: 1.

| Model               | Table           | Field                | Kind      | Required | Optional | Default    | Relation       |
| ------------------- | --------------- | -------------------- | --------- | -------- | -------- | ---------- | -------------- |
| `base.cron`         | `crons`         | `code`               | string    | Yes      | No       | No         | —              |
| `base.cron`         | `crons`         | `company`            | belongsTo | No       | Yes      | No         | `base.company` |
| `base.cron`         | `crons`         | `concurrency_policy` | enum      | No       | Yes      | [redacted] | —              |
| `base.cron`         | `crons`         | `cron_expression`    | string    | Yes      | No       | No         | —              |
| `base.cron`         | `crons`         | `enabled`            | boolean   | No       | Yes      | [redacted] | —              |
| `base.cron`         | `crons`         | `handler`            | string    | Yes      | No       | No         | —              |
| `base.cron`         | `crons`         | `handler_version`    | integer   | No       | Yes      | [redacted] | —              |
| `base.cron`         | `crons`         | `max_catch_up`       | integer   | No       | Yes      | [redacted] | —              |
| `base.cron`         | `crons`         | `misfire_policy`     | enum      | No       | Yes      | [redacted] | —              |
| `base.cron`         | `crons`         | `name`               | string    | Yes      | No       | No         | —              |
| `base.cron`         | `crons`         | `next_run_at`        | string    | Yes      | No       | No         | —              |
| `base.cron`         | `crons`         | `payload`            | text      | No       | Yes      | [redacted] | —              |
| `base.cron`         | `crons`         | `requested_by`       | belongsTo | No       | Yes      | No         | `base.user`    |
| `base.cron`         | `crons`         | `timezone`           | string    | No       | Yes      | [redacted] | —              |
| `base.job`          | `jobs`          | `attempts`           | integer   | No       | Yes      | [redacted] | —              |
| `base.job`          | `jobs`          | `available_at`       | string    | Yes      | No       | No         | —              |
| `base.job`          | `jobs`          | `cancel_requested`   | boolean   | No       | Yes      | [redacted] | —              |
| `base.job`          | `jobs`          | `company`            | belongsTo | No       | Yes      | No         | `base.company` |
| `base.job`          | `jobs`          | `cron_id`            | integer   | No       | Yes      | No         | —              |
| `base.job`          | `jobs`          | `fencing_token`      | integer   | No       | Yes      | [redacted] | —              |
| `base.job`          | `jobs`          | `handler`            | string    | Yes      | No       | No         | —              |
| `base.job`          | `jobs`          | `handler_version`    | integer   | No       | Yes      | [redacted] | —              |
| `base.job`          | `jobs`          | `idempotency_key`    | string    | No       | Yes      | No         | —              |
| `base.job`          | `jobs`          | `lease_owner`        | string    | No       | Yes      | No         | —              |
| `base.job`          | `jobs`          | `lease_until`        | string    | No       | Yes      | No         | —              |
| `base.job`          | `jobs`          | `max_attempts`       | integer   | No       | Yes      | [redacted] | —              |
| `base.job`          | `jobs`          | `payload`            | text      | No       | Yes      | [redacted] | —              |
| `base.job`          | `jobs`          | `priority`           | integer   | No       | Yes      | [redacted] | —              |
| `base.job`          | `jobs`          | `requested_by`       | belongsTo | No       | Yes      | No         | `base.user`    |
| `base.job`          | `jobs`          | `schedule_key`       | string    | No       | Yes      | No         | —              |
| `base.job`          | `jobs`          | `status`             | enum      | No       | Yes      | [redacted] | —              |
| `base.job_run`      | `job_runs`      | `attempt`            | integer   | Yes      | No       | No         | —              |
| `base.job_run`      | `job_runs`      | `error_code`         | string    | No       | Yes      | No         | —              |
| `base.job_run`      | `job_runs`      | `error_message`      | text      | No       | Yes      | No         | —              |
| `base.job_run`      | `job_runs`      | `finished_at`        | string    | No       | Yes      | No         | —              |
| `base.job_run`      | `job_runs`      | `job`                | belongsTo | Yes      | No       | No         | `base.job`     |
| `base.job_run`      | `job_runs`      | `result`             | text      | No       | Yes      | No         | —              |
| `base.job_run`      | `job_runs`      | `started_at`         | string    | Yes      | No       | No         | —              |
| `base.job_run`      | `job_runs`      | `status`             | enum      | Yes      | No       | No         | —              |
| `base.job_run`      | `job_runs`      | `worker_id`          | string    | Yes      | No       | No         | —              |
| `base.outbox_event` | `outbox_events` | `actor`              | belongsTo | No       | Yes      | No         | `base.user`    |
| `base.outbox_event` | `outbox_events` | `aggregate_id`       | integer   | Yes      | No       | No         | —              |
| `base.outbox_event` | `outbox_events` | `aggregate_model`    | string    | Yes      | No       | No         | —              |
| `base.outbox_event` | `outbox_events` | `attempts`           | integer   | No       | Yes      | [redacted] | —              |
| `base.outbox_event` | `outbox_events` | `available_at`       | string    | Yes      | No       | No         | —              |
| `base.outbox_event` | `outbox_events` | `company`            | belongsTo | No       | Yes      | No         | `base.company` |
| `base.outbox_event` | `outbox_events` | `created_at`         | string    | No       | Yes      | [redacted] | —              |
| `base.outbox_event` | `outbox_events` | `event_type`         | string    | Yes      | No       | No         | —              |
| `base.outbox_event` | `outbox_events` | `fencing_token`      | integer   | No       | Yes      | [redacted] | —              |
| `base.outbox_event` | `outbox_events` | `last_error`         | text      | No       | Yes      | No         | —              |
| `base.outbox_event` | `outbox_events` | `lease_owner`        | string    | No       | Yes      | No         | —              |
| `base.outbox_event` | `outbox_events` | `lease_until`        | string    | No       | Yes      | No         | —              |
| `base.outbox_event` | `outbox_events` | `max_attempts`       | integer   | No       | Yes      | [redacted] | —              |
| `base.outbox_event` | `outbox_events` | `payload`            | text      | Yes      | No       | No         | —              |
| `base.outbox_event` | `outbox_events` | `published_at`       | string    | No       | Yes      | No         | —              |
| `base.outbox_event` | `outbox_events` | `status`             | enum      | No       | Yes      | [redacted] | —              |

### Menus and seed coverage

| Menu model | Label | Group | Sequence | Visibility |
| ---------- | ----- | ----- | -------: | ---------- |

- Seed coverage: `base.cron` has 1 declared seed row(s); seed values are not included.

## Addon `knowledge`

Version: `1.6.0`; dependencies: `base`.

Models: 15; declared views: 3; menu entries: 3; seed rows: 26.

| Model                                           | Table                                            | Field                         | Kind      | Required | Optional | Default    | Relation                           |
| ----------------------------------------------- | ------------------------------------------------ | ----------------------------- | --------- | -------- | -------- | ---------- | ---------------------------------- |
| `knowledge.concept_profile_version`             | `knowledge_concept_profile_versions`             | `company`                     | belongsTo | Yes      | No       | No         | `base.company`                     |
| `knowledge.concept_profile_version`             | `knowledge_concept_profile_versions`             | `concept_id`                  | string    | Yes      | No       | No         | —                                  |
| `knowledge.concept_profile_version`             | `knowledge_concept_profile_versions`             | `profile_digest`              | string    | Yes      | No       | No         | —                                  |
| `knowledge.concept_profile_version`             | `knowledge_concept_profile_versions`             | `profile_id`                  | string    | Yes      | No       | No         | —                                  |
| `knowledge.concept_profile_version`             | `knowledge_concept_profile_versions`             | `profile_json`                | text      | Yes      | No       | No         | —                                  |
| `knowledge.concept_profile_version`             | `knowledge_concept_profile_versions`             | `recorded_by`                 | belongsTo | Yes      | No       | No         | `base.user`                        |
| `knowledge.concept_profile_version`             | `knowledge_concept_profile_versions`             | `version`                     | integer   | Yes      | No       | No         | —                                  |
| `knowledge.concept_profile_version`             | `knowledge_concept_profile_versions`             | `visibility`                  | enum      | No       | Yes      | [redacted] | —                                  |
| `knowledge.privacy_projection`                  | `knowledge_privacy_projections`                  | `company`                     | belongsTo | Yes      | No       | No         | `base.company`                     |
| `knowledge.privacy_projection`                  | `knowledge_privacy_projections`                  | `projection_digest`           | string    | No       | Yes      | No         | —                                  |
| `knowledge.privacy_projection`                  | `knowledge_privacy_projections`                  | `projection_json`             | text      | Yes      | No       | No         | —                                  |
| `knowledge.privacy_projection`                  | `knowledge_privacy_projections`                  | `projection_key`              | string    | Yes      | No       | No         | —                                  |
| `knowledge.privacy_projection`                  | `knowledge_privacy_projections`                  | `revoked_at`                  | string    | No       | Yes      | No         | —                                  |
| `knowledge.privacy_projection`                  | `knowledge_privacy_projections`                  | `state`                       | enum      | No       | Yes      | [redacted] | —                                  |
| `knowledge.privacy_projection`                  | `knowledge_privacy_projections`                  | `subject_ref_sha256`          | string    | Yes      | No       | No         | —                                  |
| `knowledge.privacy_projection`                  | `knowledge_privacy_projections`                  | `synthetic`                   | boolean   | No       | Yes      | [redacted] | —                                  |
| `knowledge.privacy_projection`                  | `knowledge_privacy_projections`                  | `visibility`                  | enum      | No       | Yes      | [redacted] | —                                  |
| `knowledge.privacy_revocation`                  | `knowledge_privacy_revocations`                  | `actor`                       | belongsTo | Yes      | No       | No         | `base.user`                        |
| `knowledge.privacy_revocation`                  | `knowledge_privacy_revocations`                  | `company`                     | belongsTo | Yes      | No       | No         | `base.company`                     |
| `knowledge.privacy_revocation`                  | `knowledge_privacy_revocations`                  | `consent_decision_ref_sha256` | string    | Yes      | No       | No         | —                                  |
| `knowledge.privacy_revocation`                  | `knowledge_privacy_revocations`                  | `decided_at`                  | string    | Yes      | No       | No         | —                                  |
| `knowledge.privacy_revocation`                  | `knowledge_privacy_revocations`                  | `event_digest`                | string    | Yes      | No       | No         | —                                  |
| `knowledge.privacy_revocation`                  | `knowledge_privacy_revocations`                  | `idempotency_key`             | string    | Yes      | No       | No         | —                                  |
| `knowledge.privacy_revocation`                  | `knowledge_privacy_revocations`                  | `subject_ref_sha256`          | string    | Yes      | No       | No         | —                                  |
| `knowledge.research_active_release`             | `knowledge_research_active_releases`             | `activated_at`                | string    | Yes      | No       | No         | —                                  |
| `knowledge.research_active_release`             | `knowledge_research_active_releases`             | `corpus_key`                  | string    | Yes      | No       | No         | —                                  |
| `knowledge.research_active_release`             | `knowledge_research_active_releases`             | `release`                     | belongsTo | Yes      | No       | No         | `knowledge.research_graph_release` |
| `knowledge.research_actor_identity`             | `knowledge_research_actor_identities`            | `canonical_user_id`           | string    | Yes      | No       | No         | —                                  |
| `knowledge.research_actor_identity`             | `knowledge_research_actor_identities`            | `provisioned_by`              | belongsTo | No       | Yes      | No         | `base.user`                        |
| `knowledge.research_actor_identity`             | `knowledge_research_actor_identities`            | `reason`                      | text      | No       | Yes      | No         | —                                  |
| `knowledge.research_actor_identity`             | `knowledge_research_actor_identities`            | `request_id`                  | string    | No       | Yes      | No         | —                                  |
| `knowledge.research_actor_identity`             | `knowledge_research_actor_identities`            | `user`                        | belongsTo | Yes      | No       | No         | `base.user`                        |
| `knowledge.research_graph_record`               | `knowledge_research_graph_records`               | `content_digest`              | string    | Yes      | No       | No         | —                                  |
| `knowledge.research_graph_record`               | `knowledge_research_graph_records`               | `content_json`                | text      | Yes      | No       | No         | —                                  |
| `knowledge.research_graph_record`               | `knowledge_research_graph_records`               | `record_key`                  | string    | Yes      | No       | No         | —                                  |
| `knowledge.research_graph_record`               | `knowledge_research_graph_records`               | `record_kind`                 | enum      | Yes      | No       | No         | —                                  |
| `knowledge.research_graph_record`               | `knowledge_research_graph_records`               | `release`                     | belongsTo | Yes      | No       | No         | `knowledge.research_graph_release` |
| `knowledge.research_graph_record`               | `knowledge_research_graph_records`               | `visibility`                  | enum      | Yes      | No       | No         | —                                  |
| `knowledge.research_graph_release`              | `knowledge_research_graph_releases`              | `manifest_digest`             | string    | Yes      | No       | No         | —                                  |
| `knowledge.research_graph_release`              | `knowledge_research_graph_releases`              | `manifest_json`               | text      | Yes      | No       | No         | —                                  |
| `knowledge.research_graph_release`              | `knowledge_research_graph_releases`              | `previous_release_digest`     | string    | No       | Yes      | No         | —                                  |
| `knowledge.research_graph_release`              | `knowledge_research_graph_releases`              | `record_count`                | integer   | Yes      | No       | No         | —                                  |
| `knowledge.research_graph_release`              | `knowledge_research_graph_releases`              | `release_digest`              | string    | Yes      | No       | No         | —                                  |
| `knowledge.research_graph_release`              | `knowledge_research_graph_releases`              | `schema_version`              | string    | Yes      | No       | No         | —                                  |
| `knowledge.research_review_event`               | `knowledge_research_review_events`               | `event_digest`                | string    | Yes      | No       | No         | —                                  |
| `knowledge.research_review_event`               | `knowledge_research_review_events`               | `event_id`                    | string    | Yes      | No       | No         | —                                  |
| `knowledge.research_review_event`               | `knowledge_research_review_events`               | `event_json`                  | text      | Yes      | No       | No         | —                                  |
| `knowledge.research_review_event`               | `knowledge_research_review_events`               | `idempotency_key`             | string    | Yes      | No       | No         | —                                  |
| `knowledge.research_review_event`               | `knowledge_research_review_events`               | `research_release_digest`     | string    | Yes      | No       | No         | —                                  |
| `knowledge.research_review_event`               | `knowledge_research_review_events`               | `subject_id`                  | string    | Yes      | No       | No         | —                                  |
| `knowledge.research_review_event`               | `knowledge_research_review_events`               | `subject_revision`            | integer   | Yes      | No       | No         | —                                  |
| `knowledge.research_review_event`               | `knowledge_research_review_events`               | `workflow_event_sequence`     | integer   | Yes      | No       | No         | —                                  |
| `knowledge.research_review_event`               | `knowledge_research_review_events`               | `workflow_instance_id`        | integer   | Yes      | No       | No         | —                                  |
| `knowledge.research_suggestion_version`         | `knowledge_research_suggestion_versions`         | `company`                     | belongsTo | Yes      | No       | No         | `base.company`                     |
| `knowledge.research_suggestion_version`         | `knowledge_research_suggestion_versions`         | `recorded_by`                 | belongsTo | Yes      | No       | No         | `base.user`                        |
| `knowledge.research_suggestion_version`         | `knowledge_research_suggestion_versions`         | `status`                      | enum      | No       | Yes      | [redacted] | —                                  |
| `knowledge.research_suggestion_version`         | `knowledge_research_suggestion_versions`         | `suggestion_digest`           | string    | Yes      | No       | No         | —                                  |
| `knowledge.research_suggestion_version`         | `knowledge_research_suggestion_versions`         | `suggestion_id`               | string    | Yes      | No       | No         | —                                  |
| `knowledge.research_suggestion_version`         | `knowledge_research_suggestion_versions`         | `suggestion_json`             | text      | Yes      | No       | No         | —                                  |
| `knowledge.research_suggestion_version`         | `knowledge_research_suggestion_versions`         | `version`                     | integer   | Yes      | No       | No         | —                                  |
| `knowledge.research_suggestion_version`         | `knowledge_research_suggestion_versions`         | `visibility`                  | enum      | No       | Yes      | [redacted] | —                                  |
| `knowledge.story_page_version`                  | `knowledge_story_page_versions`                  | `media_ref_json`              | text      | No       | Yes      | No         | —                                  |
| `knowledge.story_page_version`                  | `knowledge_story_page_versions`                  | `original_text`               | text      | Yes      | No       | No         | —                                  |
| `knowledge.story_page_version`                  | `knowledge_story_page_versions`                  | `original_text_digest`        | string    | Yes      | No       | No         | —                                  |
| `knowledge.story_page_version`                  | `knowledge_story_page_versions`                  | `page_id`                     | string    | Yes      | No       | No         | —                                  |
| `knowledge.story_page_version`                  | `knowledge_story_page_versions`                  | `page_order`                  | integer   | Yes      | No       | No         | —                                  |
| `knowledge.story_page_version`                  | `knowledge_story_page_versions`                  | `story_version`               | belongsTo | Yes      | No       | No         | `knowledge.story_version`          |
| `knowledge.story_version`                       | `knowledge_story_versions`                       | `company`                     | belongsTo | Yes      | No       | No         | `base.company`                     |
| `knowledge.story_version`                       | `knowledge_story_versions`                       | `page_count`                  | integer   | Yes      | No       | No         | —                                  |
| `knowledge.story_version`                       | `knowledge_story_versions`                       | `previous_story_digest`       | string    | No       | Yes      | No         | —                                  |
| `knowledge.story_version`                       | `knowledge_story_versions`                       | `recorded_by`                 | belongsTo | Yes      | No       | No         | `base.user`                        |
| `knowledge.story_version`                       | `knowledge_story_versions`                       | `story_digest`                | string    | Yes      | No       | No         | —                                  |
| `knowledge.story_version`                       | `knowledge_story_versions`                       | `story_id`                    | string    | Yes      | No       | No         | —                                  |
| `knowledge.story_version`                       | `knowledge_story_versions`                       | `story_json`                  | text      | Yes      | No       | No         | —                                  |
| `knowledge.story_version`                       | `knowledge_story_versions`                       | `title`                       | string    | Yes      | No       | No         | —                                  |
| `knowledge.story_version`                       | `knowledge_story_versions`                       | `version`                     | integer   | Yes      | No       | No         | —                                  |
| `knowledge.story_version`                       | `knowledge_story_versions`                       | `visibility`                  | enum      | No       | Yes      | [redacted] | —                                  |
| `knowledge.textual_alignment_candidate_version` | `knowledge_textual_alignment_candidate_versions` | `candidate_digest`            | string    | Yes      | No       | No         | —                                  |
| `knowledge.textual_alignment_candidate_version` | `knowledge_textual_alignment_candidate_versions` | `candidate_id`                | string    | Yes      | No       | No         | —                                  |
| `knowledge.textual_alignment_candidate_version` | `knowledge_textual_alignment_candidate_versions` | `candidate_json`              | text      | Yes      | No       | No         | —                                  |
| `knowledge.textual_alignment_candidate_version` | `knowledge_textual_alignment_candidate_versions` | `company`                     | belongsTo | Yes      | No       | No         | `base.company`                     |
| `knowledge.textual_alignment_candidate_version` | `knowledge_textual_alignment_candidate_versions` | `recorded_by`                 | belongsTo | Yes      | No       | No         | `base.user`                        |
| `knowledge.textual_alignment_candidate_version` | `knowledge_textual_alignment_candidate_versions` | `version`                     | integer   | Yes      | No       | No         | —                                  |
| `knowledge.textual_alignment_candidate_version` | `knowledge_textual_alignment_candidate_versions` | `visibility`                  | enum      | No       | Yes      | [redacted] | —                                  |
| `knowledge.witness_correction`                  | `knowledge_witness_corrections`                  | `asserted_time_precision`     | enum      | No       | Yes      | [redacted] | —                                  |
| `knowledge.witness_correction`                  | `knowledge_witness_corrections`                  | `asserted_time_text`          | string    | Yes      | No       | No         | —                                  |
| `knowledge.witness_correction`                  | `knowledge_witness_corrections`                  | `correction_text`             | text      | Yes      | No       | No         | —                                  |
| `knowledge.witness_correction`                  | `knowledge_witness_corrections`                  | `reason`                      | text      | Yes      | No       | No         | —                                  |
| `knowledge.witness_correction`                  | `knowledge_witness_corrections`                  | `recorded_by`                 | belongsTo | Yes      | No       | No         | `base.user`                        |
| `knowledge.witness_correction`                  | `knowledge_witness_corrections`                  | `sequence`                    | integer   | Yes      | No       | No         | —                                  |
| `knowledge.witness_correction`                  | `knowledge_witness_corrections`                  | `source_digest`               | string    | Yes      | No       | No         | —                                  |
| `knowledge.witness_correction`                  | `knowledge_witness_corrections`                  | `source_label`                | string    | Yes      | No       | No         | —                                  |
| `knowledge.witness_correction`                  | `knowledge_witness_corrections`                  | `source_locator`              | string    | Yes      | No       | No         | —                                  |
| `knowledge.witness_correction`                  | `knowledge_witness_corrections`                  | `synthetic`                   | boolean   | No       | Yes      | [redacted] | —                                  |
| `knowledge.witness_correction`                  | `knowledge_witness_corrections`                  | `testimony`                   | belongsTo | Yes      | No       | No         | `knowledge.witness_testimony`      |
| `knowledge.witness_correction`                  | `knowledge_witness_corrections`                  | `uncertainty_note`            | text      | No       | Yes      | No         | —                                  |
| `knowledge.witness_interpretation`              | `knowledge_witness_interpretations`              | `assertion_ref`               | string    | Yes      | No       | No         | —                                  |
| `knowledge.witness_interpretation`              | `knowledge_witness_interpretations`              | `epistemic_status`            | enum      | No       | Yes      | [redacted] | —                                  |
| `knowledge.witness_interpretation`              | `knowledge_witness_interpretations`              | `evidence_ref`                | string    | Yes      | No       | No         | —                                  |
| `knowledge.witness_interpretation`              | `knowledge_witness_interpretations`              | `interpretation_text`         | text      | Yes      | No       | No         | —                                  |
| `knowledge.witness_interpretation`              | `knowledge_witness_interpretations`              | `method_label`                | string    | Yes      | No       | No         | —                                  |
| `knowledge.witness_interpretation`              | `knowledge_witness_interpretations`              | `method_version`              | string    | Yes      | No       | No         | —                                  |
| `knowledge.witness_interpretation`              | `knowledge_witness_interpretations`              | `recorded_by`                 | belongsTo | Yes      | No       | No         | `base.user`                        |
| `knowledge.witness_interpretation`              | `knowledge_witness_interpretations`              | `synthetic`                   | boolean   | No       | Yes      | [redacted] | —                                  |
| `knowledge.witness_interpretation`              | `knowledge_witness_interpretations`              | `testimony`                   | belongsTo | Yes      | No       | No         | `knowledge.witness_testimony`      |
| `knowledge.witness_interpretation`              | `knowledge_witness_interpretations`              | `visibility`                  | enum      | No       | Yes      | [redacted] | —                                  |
| `knowledge.witness_testimony`                   | `knowledge_witness_testimonies`                  | `company`                     | belongsTo | No       | Yes      | No         | `base.company`                     |
| `knowledge.witness_testimony`                   | `knowledge_witness_testimonies`                  | `created_by`                  | belongsTo | Yes      | No       | No         | `base.user`                        |
| `knowledge.witness_testimony`                   | `knowledge_witness_testimonies`                  | `external_key`                | string    | Yes      | No       | No         | —                                  |
| `knowledge.witness_testimony`                   | `knowledge_witness_testimonies`                  | `original_text`               | text      | Yes      | No       | No         | —                                  |
| `knowledge.witness_testimony`                   | `knowledge_witness_testimonies`                  | `received_time_precision`     | enum      | No       | Yes      | [redacted] | —                                  |
| `knowledge.witness_testimony`                   | `knowledge_witness_testimonies`                  | `received_time_text`          | string    | Yes      | No       | No         | —                                  |
| `knowledge.witness_testimony`                   | `knowledge_witness_testimonies`                  | `source_digest`               | string    | Yes      | No       | No         | —                                  |
| `knowledge.witness_testimony`                   | `knowledge_witness_testimonies`                  | `source_label`                | string    | Yes      | No       | No         | —                                  |
| `knowledge.witness_testimony`                   | `knowledge_witness_testimonies`                  | `source_locator`              | string    | Yes      | No       | No         | —                                  |
| `knowledge.witness_testimony`                   | `knowledge_witness_testimonies`                  | `synthetic`                   | boolean   | No       | Yes      | [redacted] | —                                  |
| `knowledge.witness_testimony`                   | `knowledge_witness_testimonies`                  | `uncertainty_note`            | text      | No       | Yes      | No         | —                                  |
| `knowledge.witness_testimony`                   | `knowledge_witness_testimonies`                  | `visibility`                  | enum      | No       | Yes      | [redacted] | —                                  |

### Menus and seed coverage

| Menu model                         | Label                   | Group     | Sequence | Visibility       |
| ---------------------------------- | ----------------------- | --------- | -------: | ---------------- |
| `knowledge.witness_correction`     | Witness Corrections     | Knowledge |       81 | Development mode |
| `knowledge.witness_interpretation` | Witness Interpretations | Knowledge |       82 | Development mode |
| `knowledge.witness_testimony`      | Witness Testimony       | Knowledge |       80 | Development mode |

- Seed coverage: `base.access_group` has 2 declared seed row(s); seed values are not included.
- Seed coverage: `base.group_membership` has 2 declared seed row(s); seed values are not included.
- Seed coverage: `base.model_access` has 15 declared seed row(s); seed values are not included.
- Seed coverage: `knowledge.privacy_projection` has 1 declared seed row(s); seed values are not included.
- Seed coverage: `knowledge.witness_correction` has 2 declared seed row(s); seed values are not included.
- Seed coverage: `knowledge.witness_interpretation` has 2 declared seed row(s); seed values are not included.
- Seed coverage: `knowledge.witness_testimony` has 2 declared seed row(s); seed values are not included.

### Seeded model access rules

| Group reference   | Model                                           | Read | Create | Write | Delete |
| ----------------- | ----------------------------------------------- | ---- | ------ | ----- | ------ |
| `base.group_user` | `knowledge.concept_profile_version`             | No   | No     | No    | No     |
| `base.group_user` | `knowledge.privacy_projection`                  | No   | No     | No    | No     |
| `base.group_user` | `knowledge.privacy_revocation`                  | No   | No     | No    | No     |
| `base.group_user` | `knowledge.research_active_release`             | No   | No     | No    | No     |
| `base.group_user` | `knowledge.research_actor_identity`             | No   | No     | No    | No     |
| `base.group_user` | `knowledge.research_graph_record`               | No   | No     | No    | No     |
| `base.group_user` | `knowledge.research_graph_release`              | No   | No     | No    | No     |
| `base.group_user` | `knowledge.research_review_event`               | No   | No     | No    | No     |
| `base.group_user` | `knowledge.research_suggestion_version`         | No   | No     | No    | No     |
| `base.group_user` | `knowledge.story_page_version`                  | No   | No     | No    | No     |
| `base.group_user` | `knowledge.story_version`                       | No   | No     | No    | No     |
| `base.group_user` | `knowledge.textual_alignment_candidate_version` | No   | No     | No    | No     |
| `base.group_user` | `knowledge.witness_correction`                  | No   | No     | No    | No     |
| `base.group_user` | `knowledge.witness_interpretation`              | No   | No     | No    | No     |
| `base.group_user` | `knowledge.witness_testimony`                   | No   | No     | No    | No     |

## Addon `notification`

Version: `1.0.0`; dependencies: `base`, `jobs`.

Models: 3; declared views: 3; menu entries: 3; seed rows: 9.

| Model                       | Table                      | Field             | Kind      | Required | Optional | Default    | Relation                |
| --------------------------- | -------------------------- | ----------------- | --------- | -------- | -------- | ---------- | ----------------------- |
| `notification.notification` | `notifications`            | `body`            | text      | Yes      | No       | No         | —                       |
| `notification.notification` | `notifications`            | `channel`         | enum      | Yes      | No       | No         | —                       |
| `notification.notification` | `notifications`            | `company`         | belongsTo | Yes      | No       | No         | `base.company`          |
| `notification.notification` | `notifications`            | `delivered_at`    | string    | No       | Yes      | No         | —                       |
| `notification.notification` | `notifications`            | `delivery_status` | enum      | Yes      | No       | No         | —                       |
| `notification.notification` | `notifications`            | `idempotency_key` | string    | Yes      | No       | No         | —                       |
| `notification.notification` | `notifications`            | `read_at`         | string    | No       | Yes      | No         | —                       |
| `notification.notification` | `notifications`            | `recipient`       | belongsTo | Yes      | No       | No         | `base.user`             |
| `notification.notification` | `notifications`            | `resource_id`     | integer   | No       | Yes      | No         | —                       |
| `notification.notification` | `notifications`            | `resource_model`  | string    | No       | Yes      | No         | —                       |
| `notification.notification` | `notifications`            | `state`           | enum      | No       | Yes      | [redacted] | —                       |
| `notification.notification` | `notifications`            | `template`        | belongsTo | Yes      | No       | No         | `notification.template` |
| `notification.notification` | `notifications`            | `title`           | string    | Yes      | No       | No         | —                       |
| `notification.preference`   | `notification_preferences` | `channel`         | enum      | Yes      | No       | No         | —                       |
| `notification.preference`   | `notification_preferences` | `company`         | belongsTo | Yes      | No       | No         | `base.company`          |
| `notification.preference`   | `notification_preferences` | `enabled`         | boolean   | No       | Yes      | [redacted] | —                       |
| `notification.preference`   | `notification_preferences` | `user`            | belongsTo | Yes      | No       | No         | `base.user`             |
| `notification.template`     | `notification_templates`   | `body`            | text      | Yes      | No       | No         | —                       |
| `notification.template`     | `notification_templates`   | `channel`         | enum      | No       | Yes      | [redacted] | —                       |
| `notification.template`     | `notification_templates`   | `code`            | string    | Yes      | No       | No         | —                       |
| `notification.template`     | `notification_templates`   | `locale`          | string    | No       | Yes      | [redacted] | —                       |
| `notification.template`     | `notification_templates`   | `title`           | string    | Yes      | No       | No         | —                       |

### Menus and seed coverage

| Menu model                  | Label                    | Group     | Sequence | Visibility       |
| --------------------------- | ------------------------ | --------- | -------: | ---------------- |
| `notification.notification` | Notifications            | Workspace |       15 | Standard         |
| `notification.preference`   | Notification Preferences | Settings  |       80 | Standard         |
| `notification.template`     | Notification Templates   | Technical |      470 | Development mode |

- Seed coverage: `base.model_access` has 2 declared seed row(s); seed values are not included.
- Seed coverage: `notification.preference` has 4 declared seed row(s); seed values are not included.
- Seed coverage: `notification.template` has 3 declared seed row(s); seed values are not included.

### Seeded model access rules

| Group reference   | Model                       | Read | Create | Write | Delete |
| ----------------- | --------------------------- | ---- | ------ | ----- | ------ |
| `base.group_user` | `notification.notification` | Yes  | No     | No    | No     |
| `base.group_user` | `notification.preference`   | Yes  | No     | No    | No     |

## Addon `organization`

Version: `1.0.0`; dependencies: `base`.

Models: 4; declared views: 4; menu entries: 4; seed rows: 12.

| Model                     | Table                      | Field         | Kind      | Required | Optional | Default | Relation                  |
| ------------------------- | -------------------------- | ------------- | --------- | -------- | -------- | ------- | ------------------------- |
| `organization.department` | `organization_departments` | `code`        | string    | Yes      | No       | No      | —                         |
| `organization.department` | `organization_departments` | `company`     | belongsTo | Yes      | No       | No      | `base.company`            |
| `organization.department` | `organization_departments` | `description` | text      | No       | Yes      | No      | —                         |
| `organization.department` | `organization_departments` | `name`        | string    | Yes      | No       | No      | —                         |
| `organization.department` | `organization_departments` | `parent`      | belongsTo | No       | Yes      | No      | `organization.department` |
| `organization.membership` | `organization_memberships` | `company`     | belongsTo | Yes      | No       | No      | `base.company`            |
| `organization.membership` | `organization_memberships` | `department`  | belongsTo | Yes      | No       | No      | `organization.department` |
| `organization.membership` | `organization_memberships` | `end_date`    | string    | No       | Yes      | No      | —                         |
| `organization.membership` | `organization_memberships` | `manager`     | belongsTo | No       | Yes      | No      | `organization.membership` |
| `organization.membership` | `organization_memberships` | `position`    | belongsTo | No       | Yes      | No      | `organization.position`   |
| `organization.membership` | `organization_memberships` | `start_date`  | string    | Yes      | No       | No      | —                         |
| `organization.membership` | `organization_memberships` | `team`        | belongsTo | No       | Yes      | No      | `organization.team`       |
| `organization.membership` | `organization_memberships` | `user`        | belongsTo | Yes      | No       | No      | `base.user`               |
| `organization.position`   | `organization_positions`   | `code`        | string    | Yes      | No       | No      | —                         |
| `organization.position`   | `organization_positions`   | `company`     | belongsTo | Yes      | No       | No      | `base.company`            |
| `organization.position`   | `organization_positions`   | `department`  | belongsTo | No       | Yes      | No      | `organization.department` |
| `organization.position`   | `organization_positions`   | `description` | text      | No       | Yes      | No      | —                         |
| `organization.position`   | `organization_positions`   | `name`        | string    | Yes      | No       | No      | —                         |
| `organization.team`       | `organization_teams`       | `code`        | string    | Yes      | No       | No      | —                         |
| `organization.team`       | `organization_teams`       | `company`     | belongsTo | Yes      | No       | No      | `base.company`            |
| `organization.team`       | `organization_teams`       | `department`  | belongsTo | Yes      | No       | No      | `organization.department` |
| `organization.team`       | `organization_teams`       | `description` | text      | No       | Yes      | No      | —                         |
| `organization.team`       | `organization_teams`       | `name`        | string    | Yes      | No       | No      | —                         |
| `organization.team`       | `organization_teams`       | `parent`      | belongsTo | No       | Yes      | No      | `organization.team`       |

### Menus and seed coverage

| Menu model                | Label                | Group        | Sequence | Visibility |
| ------------------------- | -------------------- | ------------ | -------: | ---------- |
| `organization.department` | Departments          | Organization |       35 | Standard   |
| `organization.membership` | Organization Members | Organization |       38 | Standard   |
| `organization.position`   | Positions            | Organization |       37 | Standard   |
| `organization.team`       | Teams                | Organization |       36 | Standard   |

- Seed coverage: `base.model_access` has 4 declared seed row(s); seed values are not included.
- Seed coverage: `organization.department` has 2 declared seed row(s); seed values are not included.
- Seed coverage: `organization.membership` has 2 declared seed row(s); seed values are not included.
- Seed coverage: `organization.position` has 2 declared seed row(s); seed values are not included.
- Seed coverage: `organization.team` has 2 declared seed row(s); seed values are not included.

### Seeded model access rules

| Group reference   | Model                     | Read | Create | Write | Delete |
| ----------------- | ------------------------- | ---- | ------ | ----- | ------ |
| `base.group_user` | `organization.department` | Yes  | No     | No    | No     |
| `base.group_user` | `organization.membership` | Yes  | No     | No    | No     |
| `base.group_user` | `organization.position`   | Yes  | No     | No    | No     |
| `base.group_user` | `organization.team`       | Yes  | No     | No    | No     |

## Addon `orm-integration`

Version: `1.0.0`; dependencies: `base`, `jobs`.

Models: 2; declared views: 2; menu entries: 2; seed rows: 3.

| Model                          | Table                            | Field             | Kind      | Required | Optional | Default    | Relation                       |
| ------------------------------ | -------------------------------- | ----------------- | --------- | -------- | -------- | ---------- | ------------------------------ |
| `integration.webhook_delivery` | `integration_webhook_deliveries` | `attempts`        | integer   | No       | Yes      | [redacted] | —                              |
| `integration.webhook_delivery` | `integration_webhook_deliveries` | `company`         | belongsTo | Yes      | No       | No         | `base.company`                 |
| `integration.webhook_delivery` | `integration_webhook_deliveries` | `delivered_at`    | string    | No       | Yes      | No         | —                              |
| `integration.webhook_delivery` | `integration_webhook_deliveries` | `endpoint`        | belongsTo | Yes      | No       | No         | `integration.webhook_endpoint` |
| `integration.webhook_delivery` | `integration_webhook_deliveries` | `event_type`      | string    | Yes      | No       | No         | —                              |
| `integration.webhook_delivery` | `integration_webhook_deliveries` | `last_error_code` | string    | No       | Yes      | No         | —                              |
| `integration.webhook_delivery` | `integration_webhook_deliveries` | `outbox_event_id` | integer   | Yes      | No       | No         | —                              |
| `integration.webhook_delivery` | `integration_webhook_deliveries` | `response_status` | integer   | No       | Yes      | No         | —                              |
| `integration.webhook_delivery` | `integration_webhook_deliveries` | `status`          | enum      | Yes      | No       | No         | —                              |
| `integration.webhook_endpoint` | `integration_webhook_endpoints`  | `company`         | belongsTo | Yes      | No       | No         | `base.company`                 |
| `integration.webhook_endpoint` | `integration_webhook_endpoints`  | `enabled`         | boolean   | No       | Yes      | [redacted] | —                              |
| `integration.webhook_endpoint` | `integration_webhook_endpoints`  | `event_types`     | text      | No       | Yes      | [redacted] | —                              |
| `integration.webhook_endpoint` | `integration_webhook_endpoints`  | `name`            | string    | Yes      | No       | No         | —                              |
| `integration.webhook_endpoint` | `integration_webhook_endpoints`  | `secret_ref`      | string    | Yes      | No       | No         | —                              |
| `integration.webhook_endpoint` | `integration_webhook_endpoints`  | `url`             | string    | Yes      | No       | No         | —                              |

### Menus and seed coverage

| Menu model                     | Label              | Group     | Sequence | Visibility       |
| ------------------------------ | ------------------ | --------- | -------: | ---------------- |
| `integration.webhook_delivery` | Webhook Deliveries | Technical |      491 | Development mode |
| `integration.webhook_endpoint` | Webhook Endpoints  | Technical |      490 | Development mode |

- Seed coverage: `base.model_access` has 2 declared seed row(s); seed values are not included.
- Seed coverage: `integration.webhook_endpoint` has 1 declared seed row(s); seed values are not included.

### Seeded model access rules

| Group reference         | Model                          | Read | Create | Write | Delete |
| ----------------------- | ------------------------------ | ---- | ------ | ----- | ------ |
| `base.group_superadmin` | `integration.webhook_delivery` | Yes  | Yes    | Yes   | Yes    |
| `base.group_superadmin` | `integration.webhook_endpoint` | Yes  | Yes    | Yes   | Yes    |

## Addon `orm-storage`

Version: `1.0.0`; dependencies: none.

Models: 0; declared views: 0; menu entries: 0; seed rows: 0.

| Model | Table | Field | Kind | Required | Optional | Default | Relation |
| ----- | ----- | ----- | ---- | -------- | -------- | ------- | -------- |

### Menus and seed coverage

| Menu model | Label | Group | Sequence | Visibility |
| ---------- | ----- | ----- | -------: | ---------- |

## Addon `request`

Version: `1.0.0`; dependencies: `base`, `jobs`, `notification`, `workflow`.

Models: 1; declared views: 1; menu entries: 1; seed rows: 7.

| Model              | Table               | Field          | Kind      | Required | Optional | Default | Relation        |
| ------------------ | ------------------- | -------------- | --------- | -------- | -------- | ------- | --------------- |
| `request.purchase` | `purchase_requests` | `amount_minor` | integer   | Yes      | No       | No      | —               |
| `request.purchase` | `purchase_requests` | `company`      | belongsTo | Yes      | No       | No      | `base.company`  |
| `request.purchase` | `purchase_requests` | `currency`     | belongsTo | Yes      | No       | No      | `base.currency` |
| `request.purchase` | `purchase_requests` | `description`  | text      | Yes      | No       | No      | —               |
| `request.purchase` | `purchase_requests` | `title`        | string    | Yes      | No       | No      | —               |
| `request.purchase` | `purchase_requests` | `vendor`       | belongsTo | No       | Yes      | No      | `base.partner`  |

### Menus and seed coverage

| Menu model         | Label             | Group     | Sequence | Visibility |
| ------------------ | ----------------- | --------- | -------: | ---------- |
| `request.purchase` | Purchase Requests | Workspace |       24 | Standard   |

- Seed coverage: `base.model_access` has 1 declared seed row(s); seed values are not included.
- Seed coverage: `notification.template` has 3 declared seed row(s); seed values are not included.
- Seed coverage: `request.purchase` has 2 declared seed row(s); seed values are not included.
- Seed coverage: `workflow.definition` has 1 declared seed row(s); seed values are not included.

### Seeded model access rules

| Group reference   | Model              | Read | Create | Write | Delete |
| ----------------- | ------------------ | ---- | ------ | ----- | ------ |
| `base.group_user` | `request.purchase` | Yes  | Yes    | Yes   | No     |

## Addon `workflow`

Version: `1.2.0`; dependencies: `base`, `jobs`, `notification`.

Models: 4; declared views: 4; menu entries: 4; seed rows: 6.

| Model                 | Table                  | Field                 | Kind      | Required | Optional | Default    | Relation              |
| --------------------- | ---------------------- | --------------------- | --------- | -------- | -------- | ---------- | --------------------- |
| `workflow.approval`   | `workflow_approvals`   | `action`              | string    | Yes      | No       | No         | —                     |
| `workflow.approval`   | `workflow_approvals`   | `actor`               | belongsTo | Yes      | No       | No         | `base.user`           |
| `workflow.approval`   | `workflow_approvals`   | `comment`             | text      | No       | Yes      | No         | —                     |
| `workflow.approval`   | `workflow_approvals`   | `decided_at`          | string    | Yes      | No       | No         | —                     |
| `workflow.approval`   | `workflow_approvals`   | `decision`            | enum      | Yes      | No       | No         | —                     |
| `workflow.approval`   | `workflow_approvals`   | `instance`            | belongsTo | Yes      | No       | No         | `workflow.instance`   |
| `workflow.definition` | `workflow_definitions` | `code`                | string    | Yes      | No       | No         | —                     |
| `workflow.definition` | `workflow_definitions` | `config`              | text      | Yes      | No       | No         | —                     |
| `workflow.definition` | `workflow_definitions` | `enabled`             | boolean   | No       | Yes      | [redacted] | —                     |
| `workflow.definition` | `workflow_definitions` | `name`                | string    | Yes      | No       | No         | —                     |
| `workflow.definition` | `workflow_definitions` | `version`             | integer   | No       | Yes      | [redacted] | —                     |
| `workflow.event`      | `workflow_events`      | `action`              | string    | Yes      | No       | No         | —                     |
| `workflow.event`      | `workflow_events`      | `actor`               | belongsTo | No       | Yes      | No         | `base.user`           |
| `workflow.event`      | `workflow_events`      | `comment`             | text      | No       | Yes      | No         | —                     |
| `workflow.event`      | `workflow_events`      | `created_at`          | string    | Yes      | No       | No         | —                     |
| `workflow.event`      | `workflow_events`      | `from_state`          | string    | Yes      | No       | No         | —                     |
| `workflow.event`      | `workflow_events`      | `idempotency_key`     | string    | Yes      | No       | No         | —                     |
| `workflow.event`      | `workflow_events`      | `instance`            | belongsTo | Yes      | No       | No         | `workflow.instance`   |
| `workflow.event`      | `workflow_events`      | `payload`             | text      | No       | Yes      | No         | —                     |
| `workflow.event`      | `workflow_events`      | `revision`            | integer   | Yes      | No       | No         | —                     |
| `workflow.event`      | `workflow_events`      | `sequence`            | integer   | Yes      | No       | No         | —                     |
| `workflow.event`      | `workflow_events`      | `to_state`            | string    | Yes      | No       | No         | —                     |
| `workflow.instance`   | `workflow_instances`   | `company`             | belongsTo | Yes      | No       | No         | `base.company`        |
| `workflow.instance`   | `workflow_instances`   | `completed_at`        | string    | No       | Yes      | No         | —                     |
| `workflow.instance`   | `workflow_instances`   | `current_state`       | string    | Yes      | No       | No         | —                     |
| `workflow.instance`   | `workflow_instances`   | `definition`          | belongsTo | Yes      | No       | No         | `workflow.definition` |
| `workflow.instance`   | `workflow_instances`   | `definition_snapshot` | text      | Yes      | No       | No         | —                     |
| `workflow.instance`   | `workflow_instances`   | `definition_version`  | integer   | Yes      | No       | No         | —                     |
| `workflow.instance`   | `workflow_instances`   | `due_at`              | string    | No       | Yes      | No         | —                     |
| `workflow.instance`   | `workflow_instances`   | `resource_id`         | integer   | Yes      | No       | No         | —                     |
| `workflow.instance`   | `workflow_instances`   | `resource_model`      | string    | Yes      | No       | No         | —                     |
| `workflow.instance`   | `workflow_instances`   | `revision`            | integer   | No       | Yes      | [redacted] | —                     |
| `workflow.instance`   | `workflow_instances`   | `started_by`          | belongsTo | Yes      | No       | No         | `base.user`           |
| `workflow.instance`   | `workflow_instances`   | `status`              | enum      | No       | Yes      | [redacted] | —                     |

### Menus and seed coverage

| Menu model            | Label                | Group     | Sequence | Visibility       |
| --------------------- | -------------------- | --------- | -------: | ---------------- |
| `workflow.approval`   | Workflow Approvals   | Workspace |       20 | Standard         |
| `workflow.definition` | Workflow Definitions | Technical |      480 | Development mode |
| `workflow.event`      | Workflow History     | Workspace |       19 | Standard         |
| `workflow.instance`   | Workflows            | Workspace |       18 | Standard         |

- Seed coverage: `base.cron` has 1 declared seed row(s); seed values are not included.
- Seed coverage: `base.model_access` has 4 declared seed row(s); seed values are not included.
- Seed coverage: `workflow.definition` has 1 declared seed row(s); seed values are not included.

### Seeded model access rules

| Group reference   | Model                 | Read | Create | Write | Delete |
| ----------------- | --------------------- | ---- | ------ | ----- | ------ |
| `base.group_user` | `workflow.approval`   | Yes  | No     | No    | No     |
| `base.group_user` | `workflow.definition` | Yes  | No     | No    | No     |
| `base.group_user` | `workflow.event`      | Yes  | No     | No    | No     |
| `base.group_user` | `workflow.instance`   | Yes  | No     | No    | No     |
