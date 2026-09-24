package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"aftertick.dev/demo-analyzer/analyzer"
)

func main() {
	input := flag.String("input", "", "path to a finalized legacy CS:GO GOTV .dem file")
	pretty := flag.Bool("pretty", false, "indent JSON output")
	flag.Parse()
	if *input == "" {
		fmt.Fprintln(os.Stderr, "-input is required")
		os.Exit(2)
	}
	result, err := analyzer.AnalyzeFile(*input)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(false)
	if *pretty {
		encoder.SetIndent("", "  ")
	}
	if err := encoder.Encode(result); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
