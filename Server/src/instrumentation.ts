/*instrumentation.ts*/
import opentelemetry from '@opentelemetry/api';
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ConsoleSpanExporter, ReadableSpan, Span } from '@opentelemetry/sdk-trace-node';
import { SpanExporter } from '@opentelemetry/sdk-trace-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { ILogObj, Logger } from "tslog";
import {
    PeriodicExportingMetricReader,
    ConsoleMetricExporter,
} from '@opentelemetry/sdk-metrics';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { Resource } from '@opentelemetry/resources'
import { SEMRESATTRS_SERVICE_NAME } from '@opentelemetry/semantic-conventions'
import { ExportResult } from '@opentelemetry/core';
import { WSInstrumentation } from 'opentelemetry-instrumentation-ws';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { MeterProvider } from '@opentelemetry/sdk-metrics';
import { HookInfo } from 'opentelemetry-instrumentation-ws/dist/src/types';


const logger = new Logger<ILogObj>({ name: 'Instrumentation' });

const jaegerHost = process.env.JAEGER_URI || "http://localhost:4318";

logger.debug("Jaeger URI: " + jaegerHost);

const exporterOptions = {
    url: `${jaegerHost}/v1/traces`
}

// const metricsExporter = {
//     url: `${jaegerHost}/v1/metrics`
// }

// fetch(exporterOptions.url).then(() => { console.log('jaeger is ready') }).catch((e) => { console.error(e) })

// Wrapper that can be used to have multiple exporters where we can export spans and for example also print to console
class MultiExporter implements SpanExporter {
    private exporters: SpanExporter[];

    constructor(...exporters: SpanExporter[]) {
        this.exporters = exporters;
    }

    export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
        this.exporters.forEach(exporter => exporter.export(spans, resultCallback))
    }

    shutdown(): Promise<void> {
        return Promise.all(this.exporters.map(exporter => exporter.shutdown()))
            .then(() => { })
            .catch(error => {
                logger.error('Error exporting spans:', error);
            });
    }

    forceFlush?(): Promise<void> {
        return Promise.all(this.exporters.map(exporter => {
            if (typeof (exporter as any).forceFlush === 'function') {
                return (exporter as any).forceFlush();
            }
            return Promise.resolve();
        })).then(() => { });
    }
}


const resource = Resource.default().merge(
    new Resource({
      [SEMRESATTRS_SERVICE_NAME]: 'Citrine-Server',
    }),
  );


const options = { port: 9464 };
// prometheus exporter/collector
const prometheusExporter = new PrometheusExporter(options, (error) => {
    if (error) {
        logger.error("Prometheus exporter error: " + error)
    } else {
        logger.debug(`Prometheus exporter is ready on http://localhost:${options.port}`)
    }
});

// const metricReader = new PeriodicExportingMetricReader({
//     exporter: new ConsoleMetricExporter(),
//     // Default is 60000ms (60 seconds). Set to 10 seconds for demonstrative purposes only.
//     exportIntervalMillis: 2000,
//   });

  const myServiceMeterProvider = new MeterProvider({
    resource: resource,
    readers: [prometheusExporter],
  });

// Id we set leve to debug there will be lot's of logs  
diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);

const sdk = new NodeSDK({
    traceExporter: new MultiExporter(
        new OTLPTraceExporter(exporterOptions),
        // new ConsoleSpanExporter()
    ),
    // metricReader: new PeriodicExportingMetricReader({
    //     exporter: new ConsoleMetricExporter(),
    // }),
    resource: new Resource({
        [SEMRESATTRS_SERVICE_NAME]: 'Citrine'
    }),
    instrumentations: [getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
    }), new WSInstrumentation()],
});

sdk.start();

opentelemetry.metrics.setGlobalMeterProvider(myServiceMeterProvider);

const meter =  myServiceMeterProvider.getMeter('example-citrine');

// custom metric value that will be sent ot prometheus
const counter = meter.createCounter('citrine.requests.counter');
counter.add(10, { pid: process.pid });

logger.debug("instrumentation is running..")


// // Creates MeterProvider and installs the exporter as a MetricReader
// const meterProvider = new MeterProvider({
//     readers: [prometheusExporter]
// });

// const meter = meterProvider.getMeter('example-prometheus');

// // Now, start recording data
// const counter = meter.createCounter('metric_name', {
//     description: 'Example of a counter'
//   });
//   counter.add(10, { pid: process.pid })

process.on('SIGTERM', () => {
    sdk.shutdown()
        .then(() => console.log('Tracing terminated'))
        .catch((error) => console.log('Error terminating tracing', error))
        .finally(() => process.exit(0));
});
