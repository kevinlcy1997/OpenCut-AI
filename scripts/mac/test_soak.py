import unittest
from soak import evaluate_native_soak


class SoakAcceptanceTests(unittest.TestCase):
    def report(self):
        return {"elapsed_seconds": 1801, "swap_growth_mb": 100,
                "operations": [{"operation": name, "status": "passed"} for name in ("transcribe", "llm", "image", "media")]}

    def test_successful_native_checks_do_not_approve_browser_stability(self):
        result = evaluate_native_soak(self.report(), 30)
        self.assertTrue(result["native_checks_passed"])
        self.assertFalse(result["full_stability_acceptance_passed"])
        self.assertTrue(result["unverified"])

    def test_missing_image_workload_is_not_success(self):
        report = self.report()
        report["operations"] = [row for row in report["operations"] if row["operation"] != "image"]
        self.assertFalse(evaluate_native_soak(report, 30)["native_checks_passed"])

    def test_blocked_failed_short_or_high_swap_runs_fail_native_checks(self):
        for status in ("blocked", "failed"):
            report = self.report(); report["operations"][0]["status"] = status
            self.assertFalse(evaluate_native_soak(report, 30)["native_checks_passed"])
        report = self.report(); report["elapsed_seconds"] = 1799
        self.assertFalse(evaluate_native_soak(report, 30)["native_checks_passed"])
        report = self.report(); report["swap_growth_mb"] = 1025
        self.assertFalse(evaluate_native_soak(report, 30)["native_checks_passed"])
        self.assertFalse(evaluate_native_soak(self.report(), 1)["native_checks_passed"])

    def test_absent_measurements_and_empty_operations_fail_closed(self):
        self.assertFalse(evaluate_native_soak({}, 30)["native_checks_passed"])
        report = self.report(); report["operations"] = []
        self.assertFalse(evaluate_native_soak(report, 30)["native_checks_passed"])


if __name__ == "__main__":
    unittest.main()
