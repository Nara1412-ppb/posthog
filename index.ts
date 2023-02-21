import { S3 } from 'aws-sdk'
import { randomBytes } from 'crypto'
import { brotliCompressSync, gzipSync } from 'zlib'
import { Plugin, PluginMeta, ProcessedPluginEvent, RetryError } from '@posthog/plugin-scaffold'
import { ManagedUpload } from 'aws-sdk/clients/s3'
import { Blob } from 'aws-sdk/lib/dynamodb/document_client'

export type PluginConfig = {
    awsAccessKey: string
    awsSecretAccessKey: string
    awsRegion: string
    s3BucketName: string
    s3BucketEndpoint: string
    prefix: string
    uploadMinutes: string
    uploadMegabytes: string
    eventsToIgnore: string
    eventsToExport:string
    uploadFormat: 'xlsx' | 'jsonl' | 'csv' | 'txt'
    compression: 'gzip' | 'brotli' | 'no compression'
    signatureVersion: '' | 'v4'
    sse: 'disabled' | 'AES256' | 'aws:kms'
    sseKmsKeyId: string
    s3ForcePathStyle: 'true' | 'false'
}

type S3Plugin = Plugin<{
    global: {
        s3: S3
        eventsToIgnore: Set<string>,
        eventsToExport: Set<string>
    }
    config: PluginConfig
}>

export function convertEventBatchToBuffer(events: ProcessedPluginEvent[], config:PluginConfig): Buffer {
    if(config.uploadFormat === 'xlsx' || config.uploadFormat === 'csv') {
        let str: any = arrayToCSV(events)
        return Buffer.from(str, 'binary');
    } else {
        return Buffer.from(events.map((event) => JSON.stringify(event)).join('\n'), 'utf8')
    }
}

function arrayToCSV(objArray:any) {
    const array = typeof objArray !== 'object' ? JSON.parse(objArray) : objArray;
    let str = `${Object.keys(array[0]).map(value => `"${value}"`).join(",")}` + '\r\n';

    return array.reduce((str:any, next:any) => {
        str += `${Object.values(next).map(value =>
            `${(typeof value !== 'object') ? JSON.stringify(value):`"${value}"`}`).join(",")}` + '\r\n';
        return str;
       }, str);
}

export const setupPlugin: S3Plugin['setupPlugin'] = (meta) => {
    const { global, config } = meta
    if (!config.awsAccessKey) {
        throw new Error('AWS access key missing!')
    }
    if (!config.awsSecretAccessKey) {
        throw new Error('AWS secret access key missing!')
    }
    if (!config.awsRegion && !config.s3BucketEndpoint) {
        throw new Error('AWS region must be set if config.s3BucketEndpoint is unset!')
    }
    if (!config.s3BucketName) {
        throw new Error('S3 bucket name missing!')
    }
    if (config.sse === 'aws:kms' && !config.sseKmsKeyId) {
        throw new Error('AWS KMS encryption requested but no KMS key ID provided!')
    }

    if((config.eventsToExport.length > 0) && (config.eventsToExport.split(",").join("").trim().length === 0)) {
        throw new Error('Events to export should be comma separated and clear whitespaces if any!')
    }

    const s3Config: S3.ClientConfiguration = {
        accessKeyId: config.awsAccessKey,
        secretAccessKey: config.awsSecretAccessKey,
    }

    if (config.awsRegion) {
        s3Config.region = config.awsRegion
    }

    if (config.signatureVersion) {
        s3Config.signatureVersion = config.signatureVersion
    }

    if (config.s3ForcePathStyle === 'true') {
        s3Config.s3ForcePathStyle = true
    }

    if (config.s3BucketEndpoint) {
        s3Config.endpoint = config.s3BucketEndpoint
    }

    global.s3 = new S3(s3Config)

    global.eventsToIgnore = new Set(
        config.eventsToIgnore ? config.eventsToIgnore.split(',').map((event) => event.trim()) : null
    )

    global.eventsToExport = new Set(
        config.eventsToExport ? config.eventsToExport.split(",").map((event) => event.trim()) : null
    )
}

export const getSettings: S3Plugin['getSettings'] = (_) => {
    return {
        handlesLargeBatches: true
    }
}

export const exportEvents: S3Plugin['exportEvents'] = async (events, meta) => {
    let eventsToExport = events.filter(event => !meta.global.eventsToIgnore.has(event.event))
    if(meta.global.eventsToExport.size > 0) {
        eventsToExport = events.filter(event => meta.global.eventsToExport.has(event.event))
    }
    if (eventsToExport.length > 0) {
        await sendBatchToS3(eventsToExport, meta)
    }
}

export const sendBatchToS3 = async (events: ProcessedPluginEvent[], meta: PluginMeta<S3Plugin>) => {
    const { global, config } = meta

    console.log(`Trying to send batch to S3...`)

    const date = new Date().toISOString()
    const [day, time] = date.split('T')
    const dayTime = `${day.split('-').join('')}${time.split(':').join('')}`
    const suffix = randomBytes(8).toString('hex')
    const fileName = `${config.prefix || ''}${day}/${dayTime}.${config.uploadFormat}`;
    const params: S3.PutObjectRequest = {
        Bucket: config.s3BucketName,
        Key: fileName,
        Body: convertEventBatchToBuffer(events, config),
    }

    if (config.compression === 'gzip') {
        params.Key = `${params.Key}.gz`
        params.Body = gzipSync(params.Body as Buffer)
    }

    if (config.compression === 'brotli') {
        params.Key = `${params.Key}.br`
        params.Body = brotliCompressSync(params.Body as Buffer)
    }

    if (config.sse !== 'disabled') {
        params.ServerSideEncryption = config.sse
    }

    if (config.sse === 'aws:kms') {
        params.SSEKMSKeyId = config.sseKmsKeyId
    }

    return new Promise<void>((resolve, reject) => {
        global.s3.upload(params, (err: Error, _: ManagedUpload.SendData) => {
            if (err) {
                console.error(`Error uploading to S3: ${err.message}`)
                return reject(new RetryError())
            }
            let eventNames = "";
            events.forEach((event:ProcessedPluginEvent) => {
                eventNames += event.event;
            })
            console.log(`eventnames : ${eventNames}`)
            console.log(`Uploaded ${events.length} event${events.length === 1 ? '' : 's'} to bucket ${config.s3BucketName}`)
            resolve()
        })
    })
}

// export const sendBatchToS3 = async (events: ProcessedPluginEvent[], meta: PluginMeta<S3Plugin>) => {
//     const { global, config } = meta

//     console.log(`Trying to send batch with size ${events.length} to S3...`)

//     const date = new Date().toISOString()
//     const [day, time] = date.split('T')
//     const dayTime = `${day.split('-').join('')}-${time.split(':').join('')}`
//     const suffix = randomBytes(8).toString('hex')

//     events.forEach((event) => {
//         const fileName = `${config.prefix || ''}${day}/${dayTime}-${event.event}-${event.person ? event.person : event.distinct_id}.xlsx`;
//         const params: S3.PutObjectRequest = {
//             Bucket: config.s3BucketName,
//             Key: fileName,
//             Body: convertEventBatchToBuffer(event),
//         }
//         if (config.compression === 'gzip') {
//             params.Key = `${params.Key}.gz`
//             params.Body = gzipSync(params.Body as Buffer)
//         }

//         if (config.compression === 'brotli') {
//             params.Key = `${params.Key}.br`
//             params.Body = brotliCompressSync(params.Body as Buffer)
//         }

//         if (config.sse !== 'disabled') {
//             params.ServerSideEncryption = config.sse
//         }
//         if (config.sse === 'aws:kms') {
//             params.SSEKMSKeyId = config.sseKmsKeyId
//         }

//         return new Promise<void>((resolve, reject) => {
//             global.s3.upload(params, (err: Error, _: ManagedUpload.SendData) => {
//                 if (err) {
//                     console.error(`Error uploading to S3: ${err.message}`)
//                     return reject(new RetryError())
//                 }
//                 console.log(`Uploaded ${event.event} event with ${event.distinct_id} id to bucket ${config.s3BucketName}`)
//                 resolve()
//             })
//         })
//     })

// }
