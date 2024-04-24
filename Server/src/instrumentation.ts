import * as nodeOpentelemetry from '@opentelemetry/sdk-node';
import opentelemetry from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { PeriodicExportingMetricReader, MeterProvider } from '@opentelemetry/sdk-metrics';
import { SEMRESATTRS_SERVICE_NAME } from '@opentelemetry/semantic-conventions'
import { Resource } from '@opentelemetry/resources'
import { WSInstrumentation } from 'opentelemetry-instrumentation-ws';
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { HostMetrics } from '@opentelemetry/host-metrics';
import { ServerResponse } from 'http';
// import { HostMetrics } from '@opentelemetry/host-metrics';



// // Id we set leve to debug there will be lot's of logs  
diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);

const resource = Resource.default().merge(
    new Resource({
        [SEMRESATTRS_SERVICE_NAME]: 'Citrine-Server',
    }),
);

// const periodicMetircReader = new PeriodicExportingMetricReader({
//     exporter: new OTLPMetricExporter({
//         url: 'http://otel-collector:4318/v1/metrics', // url is optional and can be omitted - default is http://localhost:4318/v1/metrics
//         headers: {}, // an optional object containing custom headers to be sent with each request
//     }),
// })

const options = { port: 9464 };
// prometheus exporter/collector
const prometheusExporter = new PrometheusExporter(options, (error) => {
    if (error) {
        console.error("Prometheus exporter error: " + error)
    } else {
        console.log(`Prometheus exporter is ready on http://localhost:${options.port}`)
    }
});



const meterProvider = new MeterProvider({ resource: resource, views: [],readers: [prometheusExporter]});
opentelemetry.metrics.setGlobalMeterProvider(meterProvider);


const hostMetrics = new HostMetrics({
    name: 'Citrine-Host-Metrics',
    meterProvider: meterProvider,
})

const meter =  meterProvider.getMeter('example-citrine');

// custom metric value that will be sent ot prometheus
const counter = meter.createCounter('citrine.http.failure.counter');

counter.add(50, { pid: process.pid });


const httpInstrumentation = new HttpInstrumentation({
    responseHook: (span, response) => {
        if(response instanceof ServerResponse){
            //print rServerResponse headers        
    
            console.log("It's a server responce "+ response.getHeaders().toString())
        }else {

            console.log("it's incomming message url: " + response.url)
        }

        console.log("response status code: " + response.statusCode)
        if (response.statusCode && response?.statusCode >= 400) {
            console.error("detected http error: " + response.statusCode)
            counter.add(1, { pid: process.pid });
        }else {
            console.log("no error detected")
        }
    }
})


const sdk = new nodeOpentelemetry.NodeSDK({
    traceExporter: new OTLPTraceExporter({
        // optional - default url is http://localhost:4318/v1/traces
        url: 'http://otel-collector:4318/v1/traces',
        // optional - collection of custom headers to be sent with each request, empty by default
        headers: {},
    }),
    resource: resource,
    // metricReader: periodicMetircReader,
    instrumentations: [getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
        '@opentelemetry/instrumentation-http': { enabled: false },
    }), new WSInstrumentation(), httpInstrumentation],
});
sdk.start();
hostMetrics.start();

console.log('Opentelemetry initialized!!!!')



process.on('SIGTERM', () => {
    sdk.shutdown()
        .then(() => console.log('Tracing terminated'))
        .catch((error) => console.log('Error terminating tracing', error))
        .finally(() => process.exit(0));
});

// /*instrumentation.ts*/
// import opentelemetry from '@opentelemetry/api';
// import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
// import { NodeSDK } from '@opentelemetry/sdk-node';
// import { ConsoleSpanExporter, ReadableSpan, Span } from '@opentelemetry/sdk-trace-node';
// import { SpanExporter } from '@opentelemetry/sdk-trace-node';
// import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
// import { ILogObj, Logger } from "tslog";
// import {
//     PeriodicExportingMetricReader,
//     ConsoleMetricExporter,
// } from '@opentelemetry/sdk-metrics';
// import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
// import { Resource } from '@opentelemetry/resources'
// import { SEMRESATTRS_SERVICE_NAME } from '@opentelemetry/semantic-conventions'
// import { ExportResult } from '@opentelemetry/core';
// import { WSInstrumentation } from 'opentelemetry-instrumentation-ws';
// import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
// import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
// import { MeterProvider } from '@opentelemetry/sdk-metrics';
// import { HookInfo } from 'opentelemetry-instrumentation-ws/dist/src/types';


// const logger = new Logger<ILogObj>({ name: 'Instrumentation' });

// const jaegerHost = process.env.JAEGER_URI || "http://localhost:4318";

// logger.debug("Jaeger URI: " + jaegerHost);

// const exporterOptions = {
//     url: `${jaegerHost}/v1/traces`
// }

// // const metricsExporter = {
// //     url: `${jaegerHost}/v1/metrics`
// // }

// // fetch(exporterOptions.url).then(() => { console.log('jaeger is ready') }).catch((e) => { console.error(e) })

// // Wrapper that can be used to have multiple exporters where we can export spans and for example also print to console
// class MultiExporter implements SpanExporter {
//     private exporters: SpanExporter[];

//     constructor(...exporters: SpanExporter[]) {
//         this.exporters = exporters;
//     }

//     export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
//         this.exporters.forEach(exporter => exporter.export(spans, resultCallback))
//     }

//     shutdown(): Promise<void> {
//         return Promise.all(this.exporters.map(exporter => exporter.shutdown()))
//             .then(() => { })
//             .catch(error => {
//                 logger.error('Error exporting spans:', error);
//             });
//     }

//     forceFlush?(): Promise<void> {
//         return Promise.all(this.exporters.map(exporter => {
//             if (typeof (exporter as any).forceFlush === 'function') {
//                 return (exporter as any).forceFlush();
//             }
//             return Promise.resolve();
//         })).then(() => { });
//     }
// }


// const resource = Resource.default().merge(
//     new Resource({
//       [SEMRESATTRS_SERVICE_NAME]: 'Citrine-Server',
//     }),
//   );


// const options = { port: 9464 };
// // prometheus exporter/collector
// const prometheusExporter = new PrometheusExporter(options, (error) => {
//     if (error) {
//         logger.error("Prometheus exporter error: " + error)
//     } else {
//         logger.debug(`Prometheus exporter is ready on http://localhost:${options.port}`)
//     }
// });

// // const metricReader = new PeriodicExportingMetricReader({
// //     exporter: new ConsoleMetricExporter(),
// //     // Default is 60000ms (60 seconds). Set to 10 seconds for demonstrative purposes only.
// //     exportIntervalMillis: 2000,
// //   });

//   const myServiceMeterProvider = new MeterProvider({
//     resource: resource,
//     readers: [prometheusExporter],
//   });

// // Id we set leve to debug there will be lot's of logs  
// diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);

// const sdk = new NodeSDK({
//     traceExporter: new MultiExporter(
//         new OTLPTraceExporter(exporterOptions),
//         // new ConsoleSpanExporter()
//     ),
//     // metricReader: new PeriodicExportingMetricReader({
//     //     exporter: new ConsoleMetricExporter(),
//     // }),
//     resource: new Resource({
//         [SEMRESATTRS_SERVICE_NAME]: 'Citrine'
//     }),
//     instrumentations: [getNodeAutoInstrumentations({
//         '@opentelemetry/instrumentation-fs': { enabled: false },
//         '@opentelemetry/instrumentation-dns': { enabled: false },
//     }), new WSInstrumentation()],
// });

// sdk.start();

// opentelemetry.metrics.setGlobalMeterProvider(myServiceMeterProvider);

// const meter =  myServiceMeterProvider.getMeter('example-citrine');

// // custom metric value that will be sent ot prometheus
// const counter = meter.createCounter('citrine.requests.counter');
// counter.add(10, { pid: process.pid });

// logger.debug("instrumentation is running..")


// // // Creates MeterProvider and installs the exporter as a MetricReader
// // const meterProvider = new MeterProvider({
// //     readers: [prometheusExporter]
// // });

// // const meter = meterProvider.getMeter('example-prometheus');

// // // Now, start recording data
// // const counter = meter.createCounter('metric_name', {
// //     description: 'Example of a counter'
// //   });
// //   counter.add(10, { pid: process.pid })

// process.on('SIGTERM', () => {
//     sdk.shutdown()
//         .then(() => console.log('Tracing terminated'))
//         .catch((error) => console.log('Error terminating tracing', error))
//         .finally(() => process.exit(0));
// });
