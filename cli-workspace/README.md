# Self hosted CipherStash CLI workspace

This workspace is desiged to be used to validate your self hosted CipherStash Token Service and ZeroKMS instance.

## Prerequisites

- [direnv](https://direnv.net/)
- [CipherStash CLI](https://cipherstash.com/docs/reference/cli)

## Setup

Start by copying the `.envrc.example` file to `.envrc` and replace the values with your own.

```bash
cp .envrc.example .envrc
```

Then, load the environment variables using `direnv`:

```bash
direnv allow .
```

## Exposed environment variables

The CipherStash CLI uses the CipherStash Cloud as a default endpoint. To use your self hosted CipherStash Token Service and ZeroKMS instance, you need to set the following environment variables which will be loaded by `direnv`:

```bash
# Copy this file to cli-workspace/.envrc and replace the values with your own

# Auth0 CipherStash CLI application Client ID
export CS_IDP_CLIENT_ID=""

# Auth0 IDP Host URL
export CS_IDP_HOST="https://<Auth0 CipherStash CLI application Domain>/"

# Output of CipherStashCtsStack.ApiUrl
export CS_IDP_AUDIENCE="<CipherStashCtsStack.ApiUrl>"

# Output of CipherStashCtsStack.ApiUrl
export CS_MANAGEMENT_HOST="<CipherStashCtsStack.ApiUrl>"

# Output of CipherStashCtsStack.ApiUrl
export CS_CTS_HOST="<CipherStashCtsStack.ApiUrl>"

# Output of CipherStashZeroKmsStack.ApiUrl
export CS_ZEROKMS_HOST="<CipherStashZeroKmsStack.ApiUrl>"
```
