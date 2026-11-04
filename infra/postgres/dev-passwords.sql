-- Development only: the placeholder passwords of .env.example. Never mounted outside docker-compose.dev.yml.
alter role tradesoft_migrator password 'change-me';
alter role tradesoft_app password 'change-me';
alter role tradesoft_readonly password 'change-me';
