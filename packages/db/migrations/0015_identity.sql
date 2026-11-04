-- 06 §6.3 stores a pending TOTP secret before the first code confirms it, so a secret may exist while
-- totp_enrolled_at is null. The original check required both to be null together, which made enrolment
-- impossible; the rule that matters is that an enrolled account has a secret.
alter table iam.app_user drop constraint ck_app_user_mfa;
alter table iam.app_user add constraint ck_app_user_mfa check (totp_enrolled_at is null or totp_secret_ct is not null);
