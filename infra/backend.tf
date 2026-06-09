terraform {
  backend "gcs" {
    bucket = "buildkite-infra-490603-tfstate"
    prefix = "watchtron"
  }
}
